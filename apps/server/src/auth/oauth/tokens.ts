import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { oauthAccessTokens, oauthCodes, oauthConnections, oauthRefreshTokens } from '../../db/schema.js';
import { hashSecret } from '../secrets.js';
import { type AuthSettings, type ResourceKind, resourceKindOf } from '../settings.js';
import { verifyPkceS256 } from './crypto.js';
import { findClient, type IssuedPair, issueTokenPair, revokeConnection, type Tx } from './store.js';

/*
 * What the token and revocation endpoints decide, apart from HTTP (Limen's core/oauth/tokens.ts on Postgres). Each
 * grant reads its row FOR UPDATE, checks everything, and only then spends it, in one transaction: a request that fails
 * a check leaves the code or refresh token as it was, and the spend commits together with its successor. A replay
 * revokes the connection (spec §3.4), after the grant's transaction and in a transaction of its own: revoking while
 * holding the token's row would take the connection's lock after the token's, the reverse of /oauth/revoke, and the
 * two could deadlock.
 * Codes and refresh tokens belong to a client only through their connection, so the presented client_id is compared
 * with the connection's. Raw values from the request reach the database only as hashSecret() of them (hex), and a
 * client_id only through findClient's uuid check: a malformed one is a refusal, never a Postgres error.
 */

/** A refresh token presented again within 10 s of its rotation is a retry (a lost response), not theft. */
export const REFRESH_REUSE_GRACE_MS = 10_000;

export type TokenError = 'invalid_grant' | 'invalid_client' | 'invalid_scope' | 'invalid_target';
export type TokenOutcome = { ok: true; tokens: IssuedPair & { scope: string } } | { ok: false; error: TokenError };
const refuse = (error: TokenError): TokenOutcome => ({ ok: false, error });

/** A refusal that ends the connection; the revocation runs once the grant's transaction, and its row lock, are over. */
type Decision = TokenOutcome | { ok: false; error: 'invalid_grant'; revoke: string };

async function settle(db: Db, decision: Decision, now: Date): Promise<TokenOutcome> {
  if (decision.ok || !('revoke' in decision)) return decision;
  await revokeConnection(db, decision.revoke, now);
  return refuse('invalid_grant');
}

/** undefined = no resource sent (allowed); null = a resource that is not one of the two. */
const presentedKind = (auth: AuthSettings, resource: string | undefined): ResourceKind | undefined | null =>
  resource === undefined ? undefined : resourceKindOf(auth, resource);

/** The connection, if it is live and was made for this client. */
async function usableConnection(tx: Tx, id: string, clientId: string) {
  const [connection] = await tx.select().from(oauthConnections).where(eq(oauthConnections.id, id));
  return connection && connection.revokedAt === null && connection.clientId === clientId ? connection : undefined;
}

export async function exchangeCode(
  db: Db, auth: AuthSettings, input: { code: string; clientId: string; redirectUri: string; codeVerifier: string; resource?: string }, now: Date,
): Promise<TokenOutcome> {
  const presented = presentedKind(auth, input.resource);
  if (presented === null) return refuse('invalid_target');
  if (!(await findClient(db, input.clientId))) return refuse('invalid_client');
  const hash = hashSecret(input.code);
  return settle(db, await db.transaction(async (tx): Promise<Decision> => {
    const [code] = await tx.select().from(oauthCodes).where(eq(oauthCodes.hash, hash)).for('update');
    if (!code) return refuse('invalid_grant');
    // RFC 6749 §4.1.2: a code presented twice ends everything issued from it.
    if (code.usedAt !== null) return { ok: false, error: 'invalid_grant', revoke: code.connectionId };
    if (code.expiresAt <= now) return refuse('invalid_grant');
    if (presented !== undefined && presented !== code.resource) return refuse('invalid_target');
    // Exact: the code is bound to the redirect URI presented at /oauth/authorize, a loopback port included.
    if (code.redirectUri !== input.redirectUri) return refuse('invalid_grant');
    if (!verifyPkceS256(input.codeVerifier, code.codeChallenge)) return refuse('invalid_grant');
    const connection = await usableConnection(tx, code.connectionId, input.clientId);
    if (!connection) return refuse('invalid_grant');
    await tx.update(oauthCodes).set({ usedAt: now }).where(eq(oauthCodes.hash, hash));
    const pair = await issueTokenPair(tx, connection, now);
    return { ok: true, tokens: { ...pair, scope: code.scope } };
  }), now);
}

export async function refreshTokens(
  db: Db, auth: AuthSettings, input: { refreshToken: string; clientId: string; resource?: string; scope?: string }, now: Date,
): Promise<TokenOutcome> {
  const presented = presentedKind(auth, input.resource);
  if (presented === null) return refuse('invalid_target');
  if (!(await findClient(db, input.clientId))) return refuse('invalid_client');
  const hash = hashSecret(input.refreshToken);
  return settle(db, await db.transaction(async (tx): Promise<Decision> => {
    // A concurrent rotation of the same token holds this lock; once it commits, the row read here is already replaced.
    const [row] = await tx.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.hash, hash)).for('update');
    if (!row) return refuse('invalid_grant');
    if (row.replacedAt !== null) {
      const late = now.getTime() - row.replacedAt.getTime() > REFRESH_REUSE_GRACE_MS;
      return late ? { ok: false, error: 'invalid_grant', revoke: row.connectionId } : refuse('invalid_grant');
    }
    if (row.expiresAt <= now) return refuse('invalid_grant');
    const connection = await usableConnection(tx, row.connectionId, input.clientId);
    if (!connection) return refuse('invalid_grant');
    if (presented !== undefined && presented !== connection.resource) return refuse('invalid_target');
    const granted = connection.scope.split(' ').filter(Boolean);
    const asked = (input.scope ?? '').split(' ').filter(Boolean);
    if (!asked.every((s) => granted.includes(s))) return refuse('invalid_scope');
    const scope = asked.length > 0 ? granted.filter((s) => asked.includes(s)).join(' ') : connection.scope;
    await tx.update(oauthRefreshTokens).set({ replacedAt: now }).where(eq(oauthRefreshTokens.hash, hash));
    const pair = await issueTokenPair(tx, connection, now);
    return { ok: true, tokens: { ...pair, scope } };
  }), now);
}

/**
 * RFC 7009: a refresh token ends its whole connection, an access token only itself. An unknown token, or one issued
 * to another client than a given client_id, changes nothing; the endpoint answers 200 either way.
 */
export async function revokeToken(db: Db, input: { token: string; clientId?: string }, now: Date): Promise<void> {
  const hash = hashSecret(input.token);
  const issuedTo = (clientId: string) => input.clientId === undefined || input.clientId === clientId;
  await db.transaction(async (tx) => {
    const [refresh] = await tx
      .select({ connectionId: oauthRefreshTokens.connectionId, clientId: oauthConnections.clientId })
      .from(oauthRefreshTokens)
      .innerJoin(oauthConnections, eq(oauthConnections.id, oauthRefreshTokens.connectionId))
      .where(eq(oauthRefreshTokens.hash, hash));
    if (refresh) {
      if (issuedTo(refresh.clientId)) await revokeConnection(tx, refresh.connectionId, now);
      return;
    }
    const [access] = await tx
      .select({ clientId: oauthConnections.clientId, revokedAt: oauthAccessTokens.revokedAt })
      .from(oauthAccessTokens)
      .innerJoin(oauthConnections, eq(oauthConnections.id, oauthAccessTokens.connectionId))
      .where(eq(oauthAccessTokens.hash, hash));
    if (access && access.revokedAt === null && issuedTo(access.clientId)) {
      await tx.update(oauthAccessTokens).set({ revokedAt: now }).where(eq(oauthAccessTokens.hash, hash));
    }
  });
}

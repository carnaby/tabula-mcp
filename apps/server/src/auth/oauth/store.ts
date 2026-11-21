import { and, count, desc, eq, gt, isNull, lte, notExists, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { oauthAccessTokens, oauthClients, oauthCodes, oauthConnections, oauthPending, oauthRefreshTokens } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../domain/errors.js';
import { connectionNameProblem } from '../names.js';
import { hashSecret, newSecret } from '../secrets.js';
import type { ResourceKind } from '../settings.js';

/*
 * Storage of Tabula's OAuth authorization server (spec §3.4; Limen's OAuthRepo on Drizzle). Every secret is stored
 * as hashSecret() of it. Every "now" is passed in, so expiry and single use follow the caller's clock.
 */

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** A query runs on the pool or inside a transaction. */
export type Q = Db | Tx;

export type OAuthClient = typeof oauthClients.$inferSelect;
export type Pending = typeof oauthPending.$inferSelect;
export type PendingInput = Omit<typeof oauthPending.$inferInsert, 'id' | 'createdAt'>;
export type Connection = typeof oauthConnections.$inferSelect;
export type IssuedPair = { accessToken: string; refreshToken: string; expiresIn: number };

export const PENDING_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600_000;
/** Registrations nobody approved yet that the server keeps at most (as Limen §4). */
export const MAX_UNAPPROVED_CLIENTS = 1000;
/** last_used_at of a connection moves at most once a minute. */
const TOUCH_INTERVAL_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids from outside are checked before they reach a uuid column: Postgres answers a malformed one with an error, not a miss. */
export const isUuid = (s: string): boolean => UUID.test(s);

/** Postgres 23505, directly or as the cause drizzle wraps it in. */
export const isUniqueViolation = (e: unknown): boolean =>
  (e as { code?: unknown } | null)?.code === '23505' || (e as { cause?: { code?: unknown } } | null)?.cause?.code === '23505';

// ── clients ──────────────────────────────────────────────────────────────

export async function createClient(q: Q, input: { clientName: string | null; redirectUris: string[] }): Promise<OAuthClient> {
  const [row] = await q.insert(oauthClients).values(input).returning();
  return row!;
}

export async function findClient(q: Q, id: string): Promise<OAuthClient | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await q.select().from(oauthClients).where(eq(oauthClients.id, id));
  return row;
}

export async function countClientsWithoutConnection(q: Q): Promise<number> {
  const [row] = await q
    .select({ n: count() })
    .from(oauthClients)
    .where(notExists(q.select({ one: sql`1` }).from(oauthConnections).where(eq(oauthConnections.clientId, oauthClients.id))));
  return row!.n;
}

// ── pending authorizations ───────────────────────────────────────────────

export async function createPending(q: Q, input: PendingInput): Promise<Pending> {
  const [row] = await q.insert(oauthPending).values(input).returning();
  return row!;
}

/** The request, if it is still open; it stays open (a refused decision can be sent again). */
export async function findPending(q: Q, id: string, now: Date): Promise<Pending | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await q.select().from(oauthPending).where(and(eq(oauthPending.id, id), gt(oauthPending.expiresAt, now)));
  return row;
}

/** Single use: deleted as it is read, so two decisions on one request cannot both get it. */
export async function takePending(q: Q, id: string, now: Date): Promise<Pending | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await q.delete(oauthPending).where(and(eq(oauthPending.id, id), gt(oauthPending.expiresAt, now))).returning();
  return row;
}

// ── connections ──────────────────────────────────────────────────────────

export async function createConnection(
  q: Q, input: { clientId: string; name: string; resource: ResourceKind; scope: string; redirectUri: string },
): Promise<Connection> {
  const [row] = await q.insert(oauthConnections).values(input).returning();
  return row!;
}

export async function findConnection(q: Q, id: string): Promise<Connection | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await q.select().from(oauthConnections).where(eq(oauthConnections.id, id));
  return row;
}

export async function findLiveConnectionByName(q: Q, name: string): Promise<Connection | undefined> {
  const [row] = await q.select().from(oauthConnections).where(and(eq(oauthConnections.name, name), isNull(oauthConnections.revokedAt)));
  return row;
}

/** Live connections, newest first, with what each client calls itself (unverified). */
export async function listLiveConnections(db: Db): Promise<Array<Connection & { clientName: string | null }>> {
  const rows = await db
    .select({ connection: oauthConnections, clientName: oauthClients.clientName })
    .from(oauthConnections)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthConnections.clientId))
    .where(isNull(oauthConnections.revokedAt))
    .orderBy(desc(oauthConnections.createdAt));
  return rows.map((r) => ({ ...r.connection, clientName: r.clientName }));
}

/** A new name labels what the app writes from now on; earlier records keep the old one. */
export async function renameConnection(db: Db, id: string, name: string): Promise<Connection> {
  const problem = connectionNameProblem(name);
  if (problem) throw badRequest(problem);
  if (!isUuid(id)) throw notFound(`connection ${id} does not exist`);
  let row: Connection | undefined;
  try {
    [row] = await db.update(oauthConnections).set({ name }).where(and(eq(oauthConnections.id, id), isNull(oauthConnections.revokedAt))).returning();
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict(`a connection named "${name}" already exists; choose another name`);
    throw e;
  }
  if (!row) throw notFound(`connection ${id} does not exist`);
  return row;
}

/**
 * Ends a connection and everything derived from it: its access tokens are revoked, its refresh tokens and unused codes
 * expire now (the rows stay for the sweeper, so a reused one is still recognised). Idempotent; a malformed id is a no-op.
 * Locks the connection row first; callers must not hold a token or code row of the connection when calling it.
 */
export async function revokeConnection(q: Q, id: string, now: Date): Promise<void> {
  if (!isUuid(id)) return;
  // One transaction (a savepoint inside the caller's): a connection is never half revoked.
  await q.transaction(async (tx) => {
    await tx.update(oauthConnections).set({ revokedAt: now }).where(and(eq(oauthConnections.id, id), isNull(oauthConnections.revokedAt)));
    await tx.update(oauthAccessTokens).set({ revokedAt: now }).where(and(eq(oauthAccessTokens.connectionId, id), isNull(oauthAccessTokens.revokedAt)));
    await tx.update(oauthRefreshTokens).set({ expiresAt: now }).where(and(eq(oauthRefreshTokens.connectionId, id), gt(oauthRefreshTokens.expiresAt, now)));
    await tx
      .update(oauthCodes)
      .set({ expiresAt: now })
      .where(and(eq(oauthCodes.connectionId, id), isNull(oauthCodes.usedAt), gt(oauthCodes.expiresAt, now)));
  });
}

// ── codes and tokens ─────────────────────────────────────────────────────

/** A new authorization code (10 minutes, single use), returned once. */
export async function insertCode(
  q: Q,
  input: { connectionId: string; redirectUri: string; codeChallenge: string; resource: ResourceKind; scope: string; now: Date },
): Promise<string> {
  const code = newSecret();
  await q.insert(oauthCodes).values({
    hash: hashSecret(code), connectionId: input.connectionId, redirectUri: input.redirectUri, codeChallenge: input.codeChallenge,
    resource: input.resource, scope: input.scope, expiresAt: new Date(input.now.getTime() + CODE_TTL_MS),
  });
  return code;
}

/** A new access token (1 h, bound to the connection's resource) and refresh token (30 days). */
export async function issueTokenPair(q: Q, connection: Pick<Connection, 'id' | 'resource'>, now: Date): Promise<IssuedPair> {
  const accessToken = newSecret();
  const refreshToken = newSecret();
  // One transaction (a savepoint inside the caller's): never an access token without its refresh token.
  await q.transaction(async (tx) => {
    await tx.insert(oauthAccessTokens).values({
      hash: hashSecret(accessToken), connectionId: connection.id, resource: connection.resource,
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000),
    });
    await tx.insert(oauthRefreshTokens).values({
      hash: hashSecret(refreshToken), connectionId: connection.id, expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    });
  });
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/** The connection of a live access token issued for this resource, under a live connection (looked up by hash). */
export async function authenticateAccessToken(
  db: Db, raw: string, resource: ResourceKind, now: Date,
): Promise<{ ok: true; connectionId: string; name: string } | { ok: false }> {
  const [row] = await db
    .select({ connectionId: oauthConnections.id, name: oauthConnections.name, lastUsedAt: oauthConnections.lastUsedAt })
    .from(oauthAccessTokens)
    .innerJoin(oauthConnections, eq(oauthConnections.id, oauthAccessTokens.connectionId))
    .where(
      and(
        eq(oauthAccessTokens.hash, hashSecret(raw)),
        eq(oauthAccessTokens.resource, resource),
        gt(oauthAccessTokens.expiresAt, now),
        isNull(oauthAccessTokens.revokedAt),
        isNull(oauthConnections.revokedAt),
      ),
    );
  if (!row) return { ok: false };
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
    const before = new Date(now.getTime() - TOUCH_INTERVAL_MS);
    await db
      .update(oauthConnections)
      .set({ lastUsedAt: now })
      .where(and(eq(oauthConnections.id, row.connectionId), or(isNull(oauthConnections.lastUsedAt), lte(oauthConnections.lastUsedAt, before))));
  }
  return { ok: true, connectionId: row.connectionId, name: row.name };
}

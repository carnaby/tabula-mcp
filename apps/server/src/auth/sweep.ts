import { and, eq, isNotNull, lt, lte, notExists, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  appIdempotency, oauthAccessTokens, oauthClients, oauthCodes, oauthConnections, oauthPending, oauthRefreshTokens, passkeyRegistrations,
  uiSessions, webauthnChallenges,
} from '../db/schema.js';
import { IDEMPOTENCY_TTL_MS } from '../domain/idempotency.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export type AuthSweep = {
  pending: number; codes: number; refresh: number; access: number; clients: number; challenges: number; registrations: number; sessions: number;
  idempotency: number;
};

/**
 * One pass of housekeeping, every minute (spec §3.4, Limen §9). None of it is what makes an expired thing stop
 * working (every reader checks expiry itself); a used code is kept an hour and a rotated refresh token a day, so a
 * replay is still recognised and revokes its connection. Revoked connections stay: they explain old labels.
 * App API idempotency keys older than 7 days go too.
 */
export async function sweepAuth(db: Db, now: Date): Promise<AuthSweep> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  return db.transaction(async (tx) => {
    const pending = (await tx.delete(oauthPending).where(lte(oauthPending.expiresAt, now)).returning({ id: oauthPending.id })).length;
    const codes = (await tx
      .delete(oauthCodes)
      .where(or(and(isNotNull(oauthCodes.usedAt), lt(oauthCodes.usedAt, ago(HOUR))), lt(oauthCodes.expiresAt, ago(HOUR))))
      .returning({ h: oauthCodes.hash })).length;
    const refresh = (await tx
      .delete(oauthRefreshTokens)
      .where(or(and(isNotNull(oauthRefreshTokens.replacedAt), lt(oauthRefreshTokens.replacedAt, ago(DAY))), lt(oauthRefreshTokens.expiresAt, ago(DAY))))
      .returning({ h: oauthRefreshTokens.hash })).length;
    const access = (await tx.delete(oauthAccessTokens).where(lt(oauthAccessTokens.expiresAt, ago(DAY))).returning({ h: oauthAccessTokens.hash })).length;
    const clients = (await tx
      .delete(oauthClients)
      .where(and(lt(oauthClients.createdAt, ago(DAY)), notExists(tx.select({ one: sql`1` }).from(oauthConnections).where(eq(oauthConnections.clientId, oauthClients.id)))))
      .returning({ id: oauthClients.id })).length;
    const challenges = (await tx.delete(webauthnChallenges).where(lte(webauthnChallenges.expiresAt, now)).returning({ h: webauthnChallenges.challengeSha256 })).length;
    const registrations = (await tx.delete(passkeyRegistrations).where(lt(passkeyRegistrations.expiresAt, ago(DAY))).returning({ id: passkeyRegistrations.id })).length;
    const sessions = (await tx.delete(uiSessions).where(lte(uiSessions.expiresAt, now)).returning({ id: uiSessions.id })).length;
    const idempotency = (await tx.delete(appIdempotency).where(lt(appIdempotency.createdAt, ago(IDEMPOTENCY_TTL_MS))).returning({ k: appIdempotency.key })).length;
    return { pending, codes, refresh, access, clients, challenges, registrations, sessions, idempotency };
  });
}

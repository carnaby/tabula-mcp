import { and, desc, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { uiSessions } from '../db/schema.js';
import { isUuid } from './oauth/store.js';
import { hashSecret, newSecret } from './secrets.js';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** A used session is written back at most once an hour (its 30 days start again). */
const RENEW_INTERVAL_MS = 3600_000;
/** Approving an app and adding or deleting a passkey need a passkey check at most this old (spec §4.3). */
export const FRESH_AUTH_MS = 5 * 60_000;
const USER_AGENT_MAX = 300;

export type UiSession = typeof uiSessions.$inferSelect;

/** A new session, checked by a passkey just now. The cookie value is returned once; the database keeps its hash. */
export async function createSession(db: Db, input: { userAgent: string | undefined; now: Date }): Promise<{ session: UiSession; token: string }> {
  const token = newSecret();
  const [session] = await db
    .insert(uiSessions)
    .values({
      tokenSha256: hashSecret(token),
      userAgent: (input.userAgent ?? '').slice(0, USER_AGENT_MAX),
      createdAt: input.now,
      lastUsedAt: input.now,
      verifiedAt: input.now,
      expiresAt: new Date(input.now.getTime() + SESSION_TTL_MS),
    })
    .returning();
  return { session: session!, token };
}

/** The live session with this cookie value; `renewed` when this use moved its expiry (the caller sends the cookie again). */
export async function authenticateSession(db: Db, token: string, now: Date): Promise<{ session: UiSession; renewed: boolean } | undefined> {
  const [row] = await db.select().from(uiSessions).where(and(eq(uiSessions.tokenSha256, hashSecret(token)), gt(uiSessions.expiresAt, now)));
  if (!row) return undefined;
  if (now.getTime() - row.lastUsedAt.getTime() < RENEW_INTERVAL_MS) return { session: row, renewed: false };
  const [renewed] = await db
    .update(uiSessions)
    .set({ lastUsedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
    .where(eq(uiSessions.id, row.id))
    .returning();
  return renewed ? { session: renewed, renewed: true } : undefined;
}

export async function markVerified(db: Db, id: string, now: Date): Promise<void> {
  await db.update(uiSessions).set({ verifiedAt: now }).where(eq(uiSessions.id, id));
}

export const isFresh = (s: Pick<UiSession, 'verifiedAt'>, now: Date): boolean => now.getTime() - s.verifiedAt.getTime() <= FRESH_AUTH_MS;

export async function deleteSession(db: Db, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return (await db.delete(uiSessions).where(eq(uiSessions.id, id)).returning({ id: uiSessions.id })).length > 0;
}

export async function listSessions(db: Db, now: Date): Promise<UiSession[]> {
  return db.select().from(uiSessions).where(gt(uiSessions.expiresAt, now)).orderBy(desc(uiSessions.lastUsedAt));
}

/** "Chrome on Windows", "Safari on iPhone"… from a User-Agent: a hint for the owner, never trusted. */
export function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Unknown device';
}

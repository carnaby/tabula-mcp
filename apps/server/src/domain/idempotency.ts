import { and, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { appIdempotency } from '../db/schema.js';

/** A key's record is kept this long (spec §5); the sweep deletes older ones. */
export const IDEMPOTENCY_TTL_MS = 7 * 24 * 3600_000;
/** A pending key older than this belongs to a process that died: it counts as absent. */
export const STALE_PENDING_MS = 3600_000;

export type Claim =
  | { kind: 'claimed' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'mismatch' }
  | { kind: 'in_progress' };

type KeyRef = { connectionId: string; key: string };
const byKey = (k: KeyRef) => and(eq(appIdempotency.connectionId, k.connectionId), eq(appIdempotency.key, k.key));

/**
 * Takes a key for a request, or says why not. The insert is the lock: of two requests with one key only one inserts
 * (the primary key decides), and a stale pending row is taken over in the same statement. A different request under
 * the key is a mismatch whatever its state, so the answer does not depend on timing.
 */
export async function claimIdempotencyKey(db: Db, k: KeyRef & { fingerprint: string; now: Date }): Promise<Claim> {
  const stale = new Date(k.now.getTime() - STALE_PENDING_MS);
  // A row released between the insert and the read is gone: try again, a few times at most.
  for (let attempt = 0; attempt < 3; attempt++) {
    const taken = await db
      .insert(appIdempotency)
      .values({ connectionId: k.connectionId, key: k.key, fingerprint: k.fingerprint, state: 'pending', createdAt: k.now })
      .onConflictDoUpdate({
        target: [appIdempotency.connectionId, appIdempotency.key],
        set: { fingerprint: k.fingerprint, state: 'pending', responseStatus: null, responseBody: null, createdAt: k.now },
        setWhere: and(eq(appIdempotency.state, 'pending'), lt(appIdempotency.createdAt, stale)),
      })
      .returning({ key: appIdempotency.key });
    if (taken.length > 0) return { kind: 'claimed' };
    const [row] = await db.select().from(appIdempotency).where(byKey(k));
    if (!row) continue;
    if (row.fingerprint !== k.fingerprint) return { kind: 'mismatch' };
    if (row.state === 'pending') return { kind: 'in_progress' };
    return { kind: 'replay', status: row.responseStatus!, body: row.responseBody };
  }
  return { kind: 'in_progress' };
}

/** The request succeeded: its answer is what a repeat gets. */
export async function completeIdempotencyKey(db: Db, k: KeyRef & { status: number; body: unknown }): Promise<void> {
  await db
    .update(appIdempotency)
    .set({ state: 'done', responseStatus: k.status, responseBody: k.body })
    .where(and(byKey(k), eq(appIdempotency.state, 'pending')));
}

/** The request failed or broke off: the key is free for a retry. */
export async function releaseIdempotencyKey(db: Db, k: KeyRef): Promise<void> {
  await db.delete(appIdempotency).where(and(byKey(k), eq(appIdempotency.state, 'pending')));
}

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { passkeyRegistrations } from '../../db/schema.js';
import type { Q } from '../oauth/store.js';
import { hashSecret, newSecret } from '../secrets.js';

export const REGISTRATION_TTL_MS = 15 * 60_000;
export type RegistrationKind = 'link' | 'add';
/** Serializes new registration links (spec §4.2: a new link ends the older ones). */
const PASSKEY_LINK_LOCK = 7_402_118_311;

/** Permission to register one passkey, returned once. A new "link" ends the older unused links (spec §4.2). */
export async function createRegistration(db: Db, kind: RegistrationKind, now: Date): Promise<string> {
  const token = newSecret();
  await db.transaction(async (tx) => {
    if (kind === 'link') {
      // Two links made at once (a restart and admin.js passkey-link) would each expire only the links they can see.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PASSKEY_LINK_LOCK}::bigint)`);
      await tx
        .update(passkeyRegistrations)
        .set({ expiresAt: now })
        .where(and(eq(passkeyRegistrations.kind, 'link'), isNull(passkeyRegistrations.usedAt), gt(passkeyRegistrations.expiresAt, now)));
    }
    await tx.insert(passkeyRegistrations).values({ kind, tokenSha256: hashSecret(token), createdAt: now, expiresAt: new Date(now.getTime() + REGISTRATION_TTL_MS) });
  });
  return token;
}

export async function findRegistration(db: Db, token: string, now: Date): Promise<{ id: string; kind: RegistrationKind } | undefined> {
  const [row] = await db
    .select({ id: passkeyRegistrations.id, kind: passkeyRegistrations.kind })
    .from(passkeyRegistrations)
    .where(and(eq(passkeyRegistrations.tokenSha256, hashSecret(token)), isNull(passkeyRegistrations.usedAt), gt(passkeyRegistrations.expiresAt, now)));
  return row;
}

/** Compare-and-swap: of two registrations racing on one permission exactly one gets it. */
export async function useRegistration(q: Q, id: string, now: Date): Promise<boolean> {
  const rows = await q
    .update(passkeyRegistrations)
    .set({ usedAt: now })
    .where(and(eq(passkeyRegistrations.id, id), isNull(passkeyRegistrations.usedAt), gt(passkeyRegistrations.expiresAt, now)))
    .returning({ id: passkeyRegistrations.id });
  return rows.length > 0;
}

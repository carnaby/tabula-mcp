import { randomBytes } from 'node:crypto';
import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { passkeys, settings, webauthnChallenges } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../domain/errors.js';
import { isUuid, type Q } from '../oauth/store.js';
import { hashSecret } from '../secrets.js';

export type Passkey = typeof passkeys.$inferSelect;
export type ChallengePurpose = 'login' | 'register';
export const CHALLENGE_TTL_MS = 5 * 60_000;
const NAME_MAX = 60;

export const listPasskeys = (db: Db): Promise<Passkey[]> => db.select().from(passkeys).orderBy(asc(passkeys.createdAt));

export async function countPasskeys(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(passkeys);
  return row!.n;
}

export async function findPasskey(db: Db, credentialId: string): Promise<Passkey | undefined> {
  const [row] = await db.select().from(passkeys).where(eq(passkeys.credentialId, credentialId));
  return row;
}

/** A passkey's name as typed, spaces collapsed; empty becomes `fallback`. */
export function cleanPasskeyName(raw: string, fallback: string): string {
  const name = raw.replace(/\s+/g, ' ').trim() || fallback;
  if ([...name].length > NAME_MAX) throw badRequest(`a passkey name is at most ${NAME_MAX} characters`);
  if (/[\p{Cc}\p{Cf}]/u.test(name)) throw badRequest('a passkey name may not contain control or invisible characters');
  return name;
}

/** Undefined when that credential is registered already. */
export async function insertPasskey(
  q: Q, input: { credentialId: string; publicKey: string; counter: number; transports: string[]; name: string; now: Date },
): Promise<Passkey | undefined> {
  const [row] = await q
    .insert(passkeys)
    .values({ credentialId: input.credentialId, publicKey: input.publicKey, counter: input.counter, transports: input.transports, name: input.name, createdAt: input.now })
    .onConflictDoNothing({ target: passkeys.credentialId })
    .returning();
  return row;
}

/** A sign-in with this passkey. The signature counter never moves back, even when two sign-ins race. */
export async function recordPasskeyUse(db: Db, id: string, counter: number, now: Date): Promise<void> {
  await db.update(passkeys).set({ counter: sql`GREATEST(${passkeys.counter}, ${counter})`, lastUsedAt: now }).where(eq(passkeys.id, id));
}

export async function renamePasskey(db: Db, id: string, raw: string): Promise<Passkey> {
  const name = cleanPasskeyName(raw, '');
  if (!name) throw badRequest('a passkey needs a name');
  if (!isUuid(id)) throw notFound(`passkey ${id} does not exist`);
  const [row] = await db.update(passkeys).set({ name }).where(eq(passkeys.id, id)).returning();
  if (!row) throw notFound(`passkey ${id} does not exist`);
  return row;
}

/** The last passkey stays: without one only a registration link from the server lets the owner in again. */
export async function deletePasskey(db: Db, id: string): Promise<void> {
  if (!isUuid(id)) throw notFound(`passkey ${id} does not exist`);
  await db.transaction(async (tx) => {
    // Locking every row serializes two deletions, so they cannot both see two passkeys.
    const all = await tx.select({ id: passkeys.id }).from(passkeys).for('update');
    if (!all.some((p) => p.id === id)) throw notFound(`passkey ${id} does not exist`);
    if (all.length === 1) throw conflict('the last passkey cannot be deleted; add another one first');
    await tx.delete(passkeys).where(eq(passkeys.id, id));
  });
}

const USER_ID = 'webauthn_user_id';

/** The owner's WebAuthn user handle: random, stable, created on first use. */
export async function webauthnUserId(db: Db): Promise<Uint8Array<ArrayBuffer>> {
  await db.insert(settings).values({ key: USER_ID, value: { id: randomBytes(16).toString('base64url') } }).onConflictDoNothing({ target: settings.key });
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, USER_ID));
  return new Uint8Array(Buffer.from((row!.value as { id: string }).id, 'base64url'));
}

export async function saveChallenge(
  db: Db, input: { challenge: string; purpose: ChallengePurpose; registrationId: string | null; now: Date },
): Promise<void> {
  await db.insert(webauthnChallenges).values({
    challengeSha256: hashSecret(input.challenge), purpose: input.purpose, registrationId: input.registrationId,
    createdAt: input.now, expiresAt: new Date(input.now.getTime() + CHALLENGE_TTL_MS),
  });
}

/** Single use: deleted as it is checked, so a replayed response finds nothing. */
export async function consumeChallenge(
  db: Db, challenge: string, purpose: ChallengePurpose, registrationId: string | null, now: Date,
): Promise<boolean> {
  const rows = await db
    .delete(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.challengeSha256, hashSecret(challenge)),
        eq(webauthnChallenges.purpose, purpose),
        registrationId === null ? isNull(webauthnChallenges.registrationId) : eq(webauthnChallenges.registrationId, registrationId),
        gt(webauthnChallenges.expiresAt, now),
      ),
    )
    .returning({ h: webauthnChallenges.challengeSha256 });
  return rows.length > 0;
}

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';

const KEY = 'media_signing_key';

/**
 * The key that signs /media links: 32 random bytes kept in settings, created at the first start without one (two
 * starts racing keep the first). It is never returned by an API and never logged.
 */
export async function mediaSigningKey(db: Db): Promise<string> {
  await db
    .insert(settings)
    .values({ key: KEY, value: { key: randomBytes(32).toString('base64url') } })
    .onConflictDoNothing({ target: settings.key });
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY));
  const key = (row?.value as { key?: unknown } | undefined)?.key;
  if (typeof key !== 'string' || key.length < 32) throw new Error('settings.media_signing_key is malformed; delete that row to create a new key');
  return key;
}

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../../src/db/schema.js';
import { mediaSigningKey } from '../../src/media/key.js';
import { signMediaPath, verifyMediaSignature } from '../../src/media/sign.js';
import { TEST_TOKEN, useTestDb } from '../helpers.js';

const db = useTestDb();
const id = '00000000-0000-4000-8000-000000000001';
const stored = () => db.select().from(settings).where(eq(settings.key, 'media_signing_key'));

// useTestDb keeps the key between tests (apps built in beforeAll sign with it); these tests start without one.
beforeEach(async () => {
  await db.execute(sql`DELETE FROM settings WHERE key = 'media_signing_key'`);
});

describe('media signing key', () => {
  it('is created once, random, and kept in settings', async () => {
    expect(await stored()).toEqual([]);
    const first = await mediaSigningKey(db);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await mediaSigningKey(db)).toBe(first);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toEqual({ key: first });

    await db.execute(sql`DELETE FROM settings WHERE key = 'media_signing_key'`);
    expect(await mediaSigningKey(db)).not.toBe(first);
  });

  it('ends with one key when several starts race', async () => {
    expect(await stored()).toEqual([]);
    const keys = await Promise.all(Array.from({ length: 8 }, () => mediaSigningKey(db)));
    expect(new Set(keys).size).toBe(1);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toEqual({ key: keys[0] });
  });

  it('refuses a malformed stored key with a clear error that does not show the stored value', async () => {
    for (const value of [{ key: 'short' }, 'short', { other: 'short' }]) {
      await db.delete(settings).where(eq(settings.key, 'media_signing_key'));
      await db.insert(settings).values({ key: 'media_signing_key', value });
      const err = await mediaSigningKey(db).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message, JSON.stringify(value)).toBe('settings.media_signing_key is malformed; delete that row to create a new key');
      expect(err!.message).not.toContain('short');
    }
  });

  it('does not depend on any bearer token', async () => {
    const key = await mediaSigningKey(db);
    const url = new URL(`http://h${signMediaPath(key, id, 3600)}`);
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig')!;
    expect(verifyMediaSignature(key, id, exp, sig)).toBe(true);
    expect(verifyMediaSignature(TEST_TOKEN, id, exp, sig)).toBe(false);
  });
});

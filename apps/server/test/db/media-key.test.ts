import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { settings } from '../../src/db/schema.js';
import { mediaSigningKey } from '../../src/media/key.js';
import { signMediaPath, verifyMediaSignature } from '../../src/media/sign.js';
import { TEST_TOKEN, useTestDb } from '../helpers.js';

const db = useTestDb();
const id = '00000000-0000-4000-8000-000000000001';

describe('media signing key', () => {
  it('is created once, random, and kept in settings', async () => {
    const first = await mediaSigningKey(db);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await mediaSigningKey(db)).toBe(first);
    const [row] = await db.select().from(settings).where(eq(settings.key, 'media_signing_key'));
    expect(row!.value).toEqual({ key: first });
  });

  it('ends with one key when several starts race', async () => {
    const keys = await Promise.all([mediaSigningKey(db), mediaSigningKey(db), mediaSigningKey(db)]);
    expect(new Set(keys).size).toBe(1);
  });

  it('does not depend on TABULA_TOKEN', async () => {
    const key = await mediaSigningKey(db);
    const url = new URL(`http://h${signMediaPath(key, id, 3600)}`);
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig')!;
    expect(verifyMediaSignature(key, id, exp, sig)).toBe(true);
    expect(verifyMediaSignature(TEST_TOKEN, id, exp, sig)).toBe(false);
  });
});

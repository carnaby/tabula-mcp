import { and, eq, gt, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { clearedSessionCookie, readCookie, sessionCookie } from '../../src/auth/cookie.js';
import {
  cleanPasskeyName, consumeChallenge, countPasskeys, deletePasskey, insertPasskey, recordPasskeyUse, renamePasskey, saveChallenge,
  webauthnUserId,
} from '../../src/auth/passkeys/store.js';
import { createRegistration, findRegistration, useRegistration } from '../../src/auth/passkeys/registrations.js';
import { authenticateSession, createSession, deleteSession, deviceLabel, isFresh, listSessions, markVerified } from '../../src/auth/sessions.js';
import { authSettings } from '../../src/auth/settings.js';
import { passkeyRegistrations, passkeys, uiSessions } from '../../src/db/schema.js';
import { useTestDb } from '../helpers.js';

const db = useTestDb();
const at = (ms: number, from = new Date()) => new Date(from.getTime() + ms);
const HOUR = 3600_000;
const passkey = (credentialId: string) =>
  insertPasskey(db, { credentialId, publicKey: 'pk', counter: 0, transports: ['internal'], name: credentialId, now: new Date() });

describe('sessions', () => {
  it('authenticate by the cookie value, renew at most once an hour and expire after 30 days', async () => {
    const t0 = new Date();
    const { session, token } = await createSession(db, { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', now: t0 });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(await db.select().from(uiSessions))).not.toContain(token);
    expect(await authenticateSession(db, token, at(10 * 60_000, t0))).toMatchObject({ renewed: false, session: { id: session.id } });
    const renewed = await authenticateSession(db, token, at(2 * HOUR, t0));
    expect(renewed?.renewed).toBe(true);
    expect(renewed!.session.expiresAt.getTime()).toBe(at(2 * HOUR + 30 * 24 * HOUR, t0).getTime());
    expect(await authenticateSession(db, token, at(2 * HOUR + 30 * 24 * HOUR + 1, t0))).toBeUndefined();
    expect(await authenticateSession(db, 'other', t0)).toBeUndefined();
  });

  it('are fresh for five minutes after a passkey check', async () => {
    const t0 = new Date();
    const { session } = await createSession(db, { userAgent: undefined, now: t0 });
    expect(isFresh(session, at(5 * 60_000, t0))).toBe(true);
    expect(isFresh(session, at(5 * 60_000 + 1, t0))).toBe(false);
    await markVerified(db, session.id, at(HOUR, t0));
    const [row] = await db.select().from(uiSessions).where(eq(uiSessions.id, session.id));
    expect(isFresh(row!, at(HOUR + 60_000, t0))).toBe(true);
  });

  it('are listed while alive and deleted on sign-out', async () => {
    const now = new Date();
    const a = await createSession(db, { userAgent: 'a', now });
    await createSession(db, { userAgent: 'b', now: at(-31 * 24 * HOUR, now) });
    expect((await listSessions(db, now)).map((s) => s.id)).toEqual([a.session.id]);
    expect(await deleteSession(db, a.session.id)).toBe(true);
    expect(await deleteSession(db, a.session.id)).toBe(false);
    expect(await deleteSession(db, 'not-a-uuid')).toBe(false);
  });

  it('describe the device from the User-Agent', () => {
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Chrome on Windows');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')).toBe('Firefox on Linux');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge on Windows');
    expect(deviceLabel('')).toBe('Unknown device');
  });
});

describe('cookie', () => {
  const secure = authSettings({ publicUrl: 'https://tabula.example.com' })!;
  const local = authSettings({ publicUrl: 'http://localhost:3999' })!;

  it('is HttpOnly, SameSite=Strict, Path=/ and Secure on https', () => {
    expect(sessionCookie(secure, 'v', 30 * 24 * HOUR)).toBe('__Host-tabula_session=v; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict; Secure');
    expect(sessionCookie(local, 'v', 1000)).toBe('tabula_session=v; Path=/; Max-Age=1; HttpOnly; SameSite=Strict');
    expect(clearedSessionCookie(local)).toBe('tabula_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
  });

  it('is read by its exact name', () => {
    expect(readCookie('a=1; tabula_session=xyz; b=2', 'tabula_session')).toBe('xyz');
    expect(readCookie('x_tabula_session=no', 'tabula_session')).toBeUndefined();
    expect(readCookie(undefined, 'tabula_session')).toBeUndefined();
  });
});

describe('registration links', () => {
  it('work once, for 15 minutes, and a new link ends the older ones', async () => {
    const t0 = new Date();
    const first = await createRegistration(db, 'link', t0);
    expect((await findRegistration(db, first, t0))?.kind).toBe('link');
    expect(await findRegistration(db, first, at(15 * 60_000 + 1, t0))).toBeUndefined();
    const second = await createRegistration(db, 'link', at(1000, t0));
    expect(await findRegistration(db, first, at(2000, t0))).toBeUndefined();
    const add = await createRegistration(db, 'add', at(3000, t0));
    expect(await findRegistration(db, second, at(4000, t0))).toBeDefined();
    const live = (await findRegistration(db, add, at(4000, t0)))!;
    expect(await useRegistration(db, live.id, at(5000, t0))).toBe(true);
    expect(await useRegistration(db, live.id, at(6000, t0))).toBe(false);
    expect(await findRegistration(db, add, at(7000, t0))).toBeUndefined();
  });

  it('leave one live link when two are made at once', async () => {
    const now = new Date();
    // Without a lock both transactions expire the older links before either insert is visible: both stay live.
    for (let i = 0; i < 5; i++) await Promise.all([createRegistration(db, 'link', now), createRegistration(db, 'link', now)]);
    const live = await db
      .select()
      .from(passkeyRegistrations)
      .where(and(eq(passkeyRegistrations.kind, 'link'), isNull(passkeyRegistrations.usedAt), gt(passkeyRegistrations.expiresAt, now)));
    expect(live).toHaveLength(1);
  });
});

describe('WebAuthn challenges', () => {
  it('are used once, for their purpose and registration, within five minutes', async () => {
    const t0 = new Date();
    const reg = (await findRegistration(db, await createRegistration(db, 'link', t0), t0))!;
    await saveChallenge(db, { challenge: 'c1', purpose: 'login', registrationId: null, now: t0 });
    expect(await consumeChallenge(db, 'c1', 'register', null, t0)).toBe(false);
    expect(await consumeChallenge(db, 'c1', 'login', null, t0)).toBe(true);
    expect(await consumeChallenge(db, 'c1', 'login', null, t0)).toBe(false);
    await saveChallenge(db, { challenge: 'c2', purpose: 'register', registrationId: reg.id, now: t0 });
    expect(await consumeChallenge(db, 'c2', 'register', null, t0)).toBe(false);
    expect(await consumeChallenge(db, 'c2', 'register', reg.id, at(5 * 60_000 + 1, t0))).toBe(false);
    await saveChallenge(db, { challenge: 'c3', purpose: 'register', registrationId: reg.id, now: t0 });
    expect(await consumeChallenge(db, 'c3', 'register', reg.id, t0)).toBe(true);
  });
});

describe('passkeys', () => {
  it('cannot lose the last one, even when two deletions race', async () => {
    const a = (await passkey('a'))!;
    const b = (await passkey('b'))!;
    const results = await Promise.allSettled([deletePasskey(db, a.id), deletePasskey(db, b.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await countPasskeys(db)).toBe(1);
    await expect(deletePasskey(db, 'not-a-uuid')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('count a sign-in only when the signature counter moved forward', async () => {
    const p = (await passkey('c'))!;
    const t0 = new Date();
    expect(await recordPasskeyUse(db, p.id, 7, t0)).toBe(true);
    expect(await recordPasskeyUse(db, p.id, 7, at(1000, t0))).toBe(false);
    expect(await recordPasskeyUse(db, p.id, 4, at(2000, t0))).toBe(false);
    const [row] = await db.select().from(passkeys).where(eq(passkeys.id, p.id));
    expect(row).toMatchObject({ counter: 7, lastUsedAt: t0 });
  });

  it('accept every sign-in of an authenticator that keeps no counter (always 0)', async () => {
    const p = (await passkey('zero'))!;
    expect(await recordPasskeyUse(db, p.id, 0, new Date())).toBe(true);
    expect(await recordPasskeyUse(db, p.id, 0, new Date())).toBe(true);
  });

  it('ignore a second registration of the same credential', async () => {
    expect(await passkey('same')).toBeDefined();
    expect(await passkey('same')).toBeUndefined();
  });

  it('have a clean name', async () => {
    expect(cleanPasskeyName('  My   phone ', 'x')).toBe('My phone');
    expect(cleanPasskeyName('', 'Chrome on Windows')).toBe('Chrome on Windows');
    expect(() => cleanPasskeyName('x'.repeat(61), 'x')).toThrow(/60/);
    expect(() => cleanPasskeyName(`a${String.fromCharCode(0x202e)}b`, 'x')).toThrow(/invisible/);
    const p = (await passkey('k'))!;
    expect((await renamePasskey(db, p.id, 'Laptop')).name).toBe('Laptop');
    await expect(renamePasskey(db, p.id, '   ')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('share one stable WebAuthn user id', async () => {
    const id = await webauthnUserId(db);
    expect(id).toHaveLength(16);
    expect(await webauthnUserId(db)).toEqual(id);
  });
});

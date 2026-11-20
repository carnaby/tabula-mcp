import type { FastifyInstance } from 'fastify';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegistration } from '../../src/auth/passkeys/registrations.js';
import { passkeyRegistrations, passkeys, uiSessions } from '../../src/db/schema.js';
import { buildApp } from '../../src/http/app.js';
import { SoftAuthenticator } from '../soft-authenticator.js';
import { issueTestAccessToken, TEST_PUBLIC_URL, TEST_TOKEN, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config: testConfig({ publicUrl: TEST_PUBLIC_URL }), db });
});
afterAll(() => app.close());

const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload, headers: { origin: TEST_PUBLIC_URL, ...headers } });
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '').split(';')[0]!;
const me = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/auth/me', headers });

async function register(name = 'Laptop') {
  const token = await createRegistration(db, 'link', new Date());
  const key = new SoftAuthenticator(TEST_PUBLIC_URL);
  const { options } = (await post('/auth/passkey/register/options', { token })).json();
  const res = await post('/auth/passkey/register/verify', { token, name, response: key.register(options) });
  expect(res.statusCode).toBe(200);
  return { key, token, cookie: cookieOf(res) };
}

async function signIn(key: SoftAuthenticator, headers: Record<string, string> = {}, opts: { origin?: string; counter?: number } = {}) {
  const { options } = (await post('/auth/passkey/login/options', {}, headers)).json();
  return post('/auth/passkey/login/verify', { response: key.login(options, opts) }, headers);
}

describe('passkey registration', () => {
  it('stores the passkey, uses up the link and signs in', async () => {
    const { cookie, token } = await register('Laptop');
    const [p] = await db.select().from(passkeys);
    expect(p).toMatchObject({ name: 'Laptop', counter: 0, transports: ['internal'] });
    const [reg] = await db.select().from(passkeyRegistrations);
    expect(reg!.usedAt).not.toBeNull();
    expect((await post('/auth/passkey/register/options', { token })).json()).toMatchObject({ error: 'link_invalid' });
    expect((await me({ cookie })).json()).toEqual({ via: 'session', fresh: true, passkeys: 1, publicUrl: TEST_PUBLIC_URL });
  });

  it('names the passkey after the device when no name is given', async () => {
    const token = await createRegistration(db, 'link', new Date());
    const key = new SoftAuthenticator(TEST_PUBLIC_URL);
    const ua = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' };
    const { options } = (await post('/auth/passkey/register/options', { token }, ua)).json();
    expect((await post('/auth/passkey/register/verify', { token, name: '  ', response: key.register(options) }, ua)).statusCode).toBe(200);
    expect((await db.select().from(passkeys))[0]!.name).toBe('Chrome on Windows');
  });

  it('refuses an expired link, a response for another origin and a request from another site', async () => {
    const expired = await createRegistration(db, 'link', new Date(Date.now() - 16 * 60_000));
    expect((await post('/auth/passkey/register/options', { token: expired })).statusCode).toBe(400);
    const token = await createRegistration(db, 'link', new Date());
    expect((await post('/auth/passkey/register/options', { token }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    const key = new SoftAuthenticator(TEST_PUBLIC_URL);
    const { options } = (await post('/auth/passkey/register/options', { token })).json();
    const res = await post('/auth/passkey/register/verify', { token, name: 'x', response: key.register(options, { origin: 'https://evil.example' }) });
    expect(res.statusCode).toBe(400);
    expect(await db.select().from(passkeys)).toHaveLength(0);
  });

  it('refuses a challenge issued for another registration link', async () => {
    const first = await createRegistration(db, 'add', new Date());
    const second = await createRegistration(db, 'add', new Date());
    const key = new SoftAuthenticator(TEST_PUBLIC_URL);
    const { options } = (await post('/auth/passkey/register/options', { token: first })).json();
    const res = await post('/auth/passkey/register/verify', { token: second, name: 'x', response: key.register(options) });
    expect(res.json()).toMatchObject({ error: 'passkey_rejected' });
    expect(await db.select().from(passkeys)).toHaveLength(0);
    expect((await db.select().from(passkeyRegistrations)).map((r) => r.usedAt)).toEqual([null, null]);
  });

  it('stops an address after ten unknown links for a minute; a valid link does not count', async () => {
    const token = await createRegistration(db, 'link', new Date());
    const from = { 'x-forwarded-for': '203.0.113.60' };
    for (let i = 0; i < 12; i++) expect((await post('/auth/passkey/register/options', { token }, from)).statusCode).toBe(200);
    for (let i = 0; i < 10; i++) expect((await post('/auth/passkey/register/options', { token: `unknown-${i}` }, from)).statusCode).toBe(400);
    const limited = await post('/auth/passkey/register/options', { token }, from);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    const response = { id: 'x', rawId: 'x', type: 'public-key', response: {} };
    expect((await post('/auth/passkey/register/verify', { token, name: 'x', response }, from)).statusCode).toBe(429);
    expect((await post('/auth/passkey/register/options', { token }, { 'x-forwarded-for': '203.0.113.61' })).statusCode).toBe(200);
  });
});

describe('passkey sign-in', () => {
  it('starts a session and moves the counter', async () => {
    const { key } = await register();
    const res = await signIn(key);
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toMatch(/^tabula_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/);
    expect((await db.select().from(passkeys))[0]).toMatchObject({ counter: 1, lastUsedAt: expect.any(Date) });
    expect((await me({ cookie: cookieOf(res) })).json()).toMatchObject({ via: 'session', fresh: true });
  });

  it('refuses a replay, a challenge it did not issue, another origin, a counter that went back and an unknown key', async () => {
    const { key } = await register();
    const { options } = (await post('/auth/passkey/login/options', {})).json();
    const response = key.login(options);
    expect((await post('/auth/passkey/login/verify', { response })).statusCode).toBe(200);
    expect((await post('/auth/passkey/login/verify', { response })).statusCode).toBe(400);
    const forged = { challenge: Buffer.from('not issued by the server').toString('base64url') } as PublicKeyCredentialRequestOptionsJSON;
    expect((await post('/auth/passkey/login/verify', { response: key.login(forged) })).statusCode).toBe(400);
    expect((await signIn(key, {}, { origin: 'https://evil.example' })).statusCode).toBe(400);
    expect((await signIn(key, {}, { counter: 5 })).statusCode).toBe(200);
    expect((await signIn(key, {}, { counter: 3 })).statusCode).toBe(400);
    expect((await signIn(key, {}, { counter: 5 })).statusCode).toBe(400);
    expect((await db.select().from(passkeys))[0]!.counter).toBe(5);
    expect((await signIn(new SoftAuthenticator(TEST_PUBLIC_URL))).json()).toMatchObject({ error: 'passkey_rejected' });
    expect((await post('/auth/passkey/login/options', {}, { origin: 'https://evil.example' })).statusCode).toBe(403);
  });

  it('confirms an open session instead of starting another one', async () => {
    const { key, cookie } = await register();
    await db.update(uiSessions).set({ verifiedAt: new Date(Date.now() - 3600_000) });
    expect((await me({ cookie })).json()).toMatchObject({ fresh: false });
    const res = await signIn(key, { cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await db.select().from(uiSessions)).toHaveLength(1);
    expect((await me({ cookie })).json()).toMatchObject({ fresh: true });
  });

  it('stops an address after ten failures for a minute', async () => {
    const stranger = new SoftAuthenticator(TEST_PUBLIC_URL);
    const from = { 'x-forwarded-for': '203.0.113.50' };
    for (let i = 0; i < 10; i++) expect((await signIn(stranger, from)).statusCode).toBe(400);
    expect((await signIn(stranger, from)).statusCode).toBe(429);
    expect((await signIn(stranger, { 'x-forwarded-for': '203.0.113.51' })).statusCode).toBe(400);
  });
});

describe('/api/auth', () => {
  it('signs out: the session is deleted and the cookie cleared', async () => {
    const { cookie } = await register();
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: TEST_PUBLIC_URL } });
    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toBe('tabula_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
    expect(await db.select().from(uiSessions)).toHaveLength(0);
    expect((await me({ cookie })).statusCode).toBe(401);
  });

  it('answers the old token, and refuses an app connection', async () => {
    expect((await me({ authorization: `Bearer ${TEST_TOKEN}` })).json()).toEqual({ via: 'legacy', fresh: false, passkeys: 0, publicUrl: TEST_PUBLIC_URL });
    const api = await issueTestAccessToken(db, { resource: 'api' });
    expect((await me({ authorization: `Bearer ${api.value}` })).statusCode).toBe(403);
  });
});

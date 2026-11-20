import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegistration } from '../../src/auth/passkeys/registrations.js';
import { createSession } from '../../src/auth/sessions.js';
import { passkeyRegistrations, settings, uiSessions } from '../../src/db/schema.js';
import { buildApp } from '../../src/http/app.js';
import { TEST_PUBLIC_URL, TEST_TOKEN, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
const logs: string[] = [];
let app: FastifyInstance;
let bare: FastifyInstance;

beforeAll(async () => {
  // The suite runs at warn, where a request writes nothing; the masking test needs the request lines.
  const prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  app = await buildApp({ config: testConfig({ publicUrl: TEST_PUBLIC_URL }), db, logStream: { write: (m) => void logs.push(m) } });
  process.env.LOG_LEVEL = prevLevel;
  bare = await buildApp({ config: testConfig(), db });
});
afterAll(async () => {
  await app.close();
  await bare.close();
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });
const dataOf = (html: string, name: string) => new RegExp(`data-${name}="([^"]*)"`).exec(html)?.[1];
const sessionCookie = async (verifiedAgoMs = 0) => {
  const { session, token } = await createSession(db, { userAgent: 'test', now: new Date() });
  if (verifiedAgoMs) await db.update(uiSessions).set({ verifiedAt: new Date(Date.now() - verifiedAgoMs) }).where(eq(uiSessions.id, session.id));
  return `tabula_session=${token}`;
};

describe('auth pages', () => {
  it('carry a strict CSP, no framing and one same-origin script', async () => {
    const res = await get('/signin');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('<script src="/auth/passkey.js" defer></script>');
    expect(res.body).not.toMatch(/<script>|style=|https?:\/\//);
    const script = await get('/auth/passkey.js');
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.body).not.toMatch(/https?:\/\//);
    expect((await get('/auth/pages.css')).headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('return only to a local path after signing in', async () => {
    const next = async (raw: string) => dataOf((await get(`/signin?next=${encodeURIComponent(raw)}`)).body, 'next');
    expect(await next('/#/thoughts')).toBe('/#/thoughts');
    expect(await next('/oauth/authorize?client_id=x&state=y')).toBe('/oauth/authorize?client_id=x&amp;state=y');
    const control = [0, 9, 10, 13, 0x7f].map((c) => `/a${String.fromCharCode(c)}b`);
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'evil', ...control, `/${'a'.repeat(5000)}`]) {
      expect(await next(bad), JSON.stringify(bad)).toBe('/');
    }
    // A next given twice (an array in the query) is not a path either.
    expect(dataOf((await get('/signin?next=%2Fa&next=%2Fb')).body, 'next')).toBe('/');
  });

  it('say when no passkey exists yet and do not start the browser prompt then', async () => {
    const res = await get('/signin?reason=fresh');
    expect(res.body).toContain('No passkey is registered yet');
    expect(dataOf(res.body, 'auto')).toBe('0');
  });

  it('open a registration link once it is valid, and mask it in the log', async () => {
    expect((await get('/passkey/register/not-a-token')).statusCode).toBe(400);
    const token = await createRegistration(db, 'link', new Date());
    logs.length = 0;
    const res = await get(`/passkey/register/${token}`, { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res.body, 'token')).toBe(token);
    expect(res.body).toContain('value="Safari on macOS"');
    expect(logs.join()).toContain('/passkey/register/***');
    expect(logs.join()).not.toContain(token);
  });

  it('limit registration-link attempts to ten a minute per address', async () => {
    const from = { 'x-forwarded-for': '203.0.113.60' };
    for (let i = 0; i < 10; i++) expect((await get('/passkey/register/x', from)).statusCode).toBe(400);
    expect((await get('/passkey/register/x', from)).statusCode).toBe(429);
  });

  it('share the registration-link budget with the JSON ceremony', async () => {
    const from = { 'x-forwarded-for': '203.0.113.61' };
    for (let i = 0; i < 10; i++) expect((await get('/passkey/register/x', from)).statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/auth/passkey/register/options', headers: { origin: TEST_PUBLIC_URL, ...from }, payload: { token: 'x' } });
    expect(res.statusCode).toBe(429);
  });

  it('let a fresh session add a passkey, and send anyone else to sign in first', async () => {
    const signIn = '/signin?next=%2Fpasskey%2Fadd&reason=fresh';
    expect((await get('/passkey/add')).headers.location).toBe(signIn);
    expect((await get('/passkey/add', { cookie: await sessionCookie(10 * 60_000) })).headers.location).toBe(signIn);
    const res = await get('/passkey/add', { cookie: await sessionCookie() });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res.body, 'next')).toBe('/#/security');
    const [reg] = await db.select().from(passkeyRegistrations);
    expect(reg!.kind).toBe('add');
  });

  it('let the old token add the first passkey through a form from Tabula itself', async () => {
    const form = (token: string, headers: Record<string, string> = { origin: TEST_PUBLIC_URL }) =>
      app.inject({ method: 'POST', url: '/passkey/add', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, payload: new URLSearchParams({ legacy_token: token }).toString() });
    expect((await form(TEST_TOKEN, {})).statusCode).toBe(403);
    expect((await form('wrong')).statusCode).toBe(403);
    const res = await form(TEST_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(dataOf(res.body, 'token')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await db.select().from(settings).where(eq(settings.key, 'legacy_token_last_used')))[0]?.value).toEqual({ at: expect.any(String) });
  });

  it('do not exist without TABULA_PUBLIC_URL', async () => {
    for (const url of ['/signin', '/passkey/add', '/auth/passkey.js']) expect((await bare.inject({ method: 'GET', url })).statusCode).toBe(404);
  });
});

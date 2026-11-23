import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, createConnection } from '../../src/auth/oauth/store.js';
import { insertPasskey } from '../../src/auth/passkeys/store.js';
import { hashSecret } from '../../src/auth/secrets.js';
import { createSession } from '../../src/auth/sessions.js';
import { oauthConnections, passkeys, uiSessions } from '../../src/db/schema.js';
import { buildApp } from '../../src/http/app.js';
import { issueTestAccessToken, TEST_PUBLIC_URL, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config: testConfig({ publicUrl: TEST_PUBLIC_URL }), db });
});
afterAll(() => app.close());

const session = async (verifiedAgoMs = 0, userAgent = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0') => {
  const s = await createSession(db, { userAgent, now: new Date() });
  if (verifiedAgoMs) await db.update(uiSessions).set({ verifiedAt: new Date(Date.now() - verifiedAgoMs) }).where(eq(uiSessions.id, s.session.id));
  return { id: s.session.id, token: s.token, cookie: `tabula_session=${s.token}` };
};
const call = (method: 'GET' | 'PATCH' | 'POST' | 'DELETE', url: string, headers: Record<string, string>, payload?: object) =>
  app.inject({ method, url: `/api${url}`, headers: { origin: TEST_PUBLIC_URL, ...headers }, ...(payload && { payload }) });
const passkey = async (name: string) =>
  (await insertPasskey(db, { credentialId: `cred-${name}`, publicKey: 'pk', counter: 0, transports: [], name, now: new Date() }))!;

describe('GET /api/security', () => {
  it('lists passkeys, live connections and sessions', async () => {
    const me = await session();
    await session(0, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1');
    await passkey('Laptop');
    await issueTestAccessToken(db, { resource: 'mcp', name: 'claude-ai' });
    const loopback = await createClient(db, { clientName: `Evil${String.fromCharCode(0x202e)}`, redirectUris: ['http://127.0.0.1/callback'] });
    await createConnection(db, { clientId: loopback.id, name: 'tabula-cli', resource: 'api', scope: 'api', redirectUri: 'http://127.0.0.1:5000/callback' });

    const res = await call('GET', '/security', { cookie: me.cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ via: 'session', fresh: true, publicUrl: TEST_PUBLIC_URL });
    expect(body.passkeys).toEqual([{ id: expect.any(String), name: 'Laptop', createdAt: expect.any(String), lastUsedAt: null }]);
    expect(body.connections).toEqual([
      expect.objectContaining({ name: 'tabula-cli', app: 'Unnamed app', target: 'this computer', resource: 'api' }),
      expect.objectContaining({ name: 'claude-ai', app: 'Test client', target: 'client.example.com', resource: 'mcp', lastUsedAt: null }),
    ]);
    expect(body.sessions.map((s: { device: string; current: boolean }) => [s.device, s.current]).sort()).toEqual([['Chrome on Windows', true], ['Safari on iPhone', false]]);
    expect(body).not.toHaveProperty('legacy');
  });

  it('is for the person only, never an app connection', async () => {
    const api = await issueTestAccessToken(db, { resource: 'api' });
    const asApp = { authorization: `Bearer ${api.value}` };
    const k = await passkey('Kept');
    const s = await session();
    for (const [method, url] of [
      ['GET', '/security'], ['PATCH', `/passkeys/${k.id}`], ['DELETE', `/passkeys/${k.id}`], ['PATCH', `/connections/${api.connectionId}`],
      ['POST', `/connections/${api.connectionId}/revoke`], ['DELETE', `/sessions/${s.id}`], ['POST', '/auth/logout'],
    ] as const) {
      expect((await call(method, url, asApp, method === 'PATCH' ? { name: 'renamed' } : undefined)).statusCode, `${method} ${url}`).toBe(403);
    }
    // Nothing changed: the app could not rename, revoke or sign anything out.
    const body = (await call('GET', '/security', { cookie: s.cookie })).json();
    expect(body.passkeys.map((p: { name: string }) => p.name)).toEqual(['Kept']);
    expect(body.connections.map((c: { name: string }) => c.name)).toEqual(['test-api']);
    expect(body.sessions).toHaveLength(1);
  });

  it('never shows a hash or a secret', async () => {
    const me = await session();
    const app1 = await issueTestAccessToken(db, { resource: 'mcp', name: 'app-one' });
    await passkey('Laptop');
    const text = (await call('GET', '/security', { cookie: me.cookie })).body;
    for (const secret of [me.token, hashSecret(me.token), app1.value, hashSecret(app1.value)]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/sha256|hash|token_?sha|publicKey|credentialId/i);
    // No 64-hex value at all (every stored secret is a SHA-256 hex digest).
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    const keys = (o: object) => Object.keys(o).sort();
    const body = (await call('GET', '/security', { cookie: me.cookie })).json();
    expect(keys(body.sessions[0])).toEqual(['createdAt', 'current', 'device', 'id', 'lastUsedAt']);
    expect(keys(body.connections[0])).toEqual(['app', 'createdAt', 'id', 'lastUsedAt', 'name', 'resource', 'target']);
    expect(keys(body.passkeys[0])).toEqual(['createdAt', 'id', 'lastUsedAt', 'name']);
  });
});

describe('passkeys', () => {
  it('rename, and refuse a malformed or unknown id', async () => {
    const { cookie } = await session();
    const k = await passkey('Old');
    expect((await call('PATCH', `/passkeys/${k.id}`, { cookie }, { name: 'Phone' })).json()).toEqual({ id: k.id, name: 'Phone' });
    expect((await call('PATCH', '/passkeys/not-a-uuid', { cookie }, { name: 'x' })).statusCode).toBe(400);
    expect((await call('PATCH', '/passkeys/00000000-0000-4000-8000-000000000000', { cookie }, { name: 'x' })).statusCode).toBe(404);
    expect((await call('DELETE', '/passkeys/not-a-uuid', { cookie })).statusCode).toBe(400);
  });

  it('delete only with a fresh passkey check, never the last one', async () => {
    const a = await passkey('A');
    const b = await passkey('B');
    expect((await call('DELETE', `/passkeys/${a.id}`, { cookie: (await session(10 * 60_000)).cookie })).json().error).toBe('fresh_auth_required');
    const api = await issueTestAccessToken(db, { resource: 'api' });
    expect((await call('DELETE', `/passkeys/${a.id}`, { authorization: `Bearer ${api.value}` })).statusCode).toBe(403);
    const { cookie } = await session();
    expect((await call('DELETE', `/passkeys/${a.id}`, { cookie })).statusCode).toBe(204);
    expect((await call('DELETE', `/passkeys/${b.id}`, { cookie })).statusCode).toBe(409);
    expect(await db.select().from(passkeys)).toHaveLength(1);
  });
});

describe('connections', () => {
  it('rename under the label rules and revoke at once', async () => {
    const { cookie } = await session();
    const one = await issueTestAccessToken(db, { resource: 'mcp', name: 'one' });
    await issueTestAccessToken(db, { resource: 'mcp', name: 'two' });
    expect((await call('PATCH', `/connections/${one.connectionId}`, { cookie }, { name: 'uno' })).json()).toEqual({ id: one.connectionId, name: 'uno' });
    expect((await call('PATCH', `/connections/${one.connectionId}`, { cookie }, { name: 'two' })).statusCode).toBe(409);
    expect((await call('PATCH', `/connections/${one.connectionId}`, { cookie }, { name: 'human' })).statusCode).toBe(400);
    expect((await call('POST', `/connections/${one.connectionId}/revoke`, { cookie })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${one.value}` } })).statusCode).toBe(401);
    expect((await call('POST', `/connections/${one.connectionId}/revoke`, { cookie })).statusCode).toBe(404);
  });

  it('a revoked /api connection stops at once, and it is gone from the list', async () => {
    const { cookie } = await session();
    const api = await issueTestAccessToken(db, { resource: 'api', name: 'cli' });
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${api.value}` } })).statusCode).toBe(200);
    expect((await call('POST', `/connections/${api.connectionId}/revoke`, { cookie })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${api.value}` } })).statusCode).toBe(401);
    expect((await call('GET', '/security', { cookie })).json().connections).toEqual([]);
    // A revoked connection cannot be renamed either.
    expect((await call('PATCH', `/connections/${api.connectionId}`, { cookie }, { name: 'again' })).statusCode).toBe(404);
  });

  it('refuses a malformed id with 400', async () => {
    const { cookie } = await session();
    expect((await call('PATCH', '/connections/not-a-uuid', { cookie }, { name: 'x' })).statusCode).toBe(400);
    expect((await call('POST', '/connections/not-a-uuid/revoke', { cookie })).statusCode).toBe(400);
    expect((await call('POST', '/connections/00000000-0000-4000-8000-000000000000/revoke', { cookie })).statusCode).toBe(404);
  });
});

describe('sessions', () => {
  it('sign out another device, or this one with its cookie cleared', async () => {
    const me = await session();
    const other = await session();
    expect((await call('DELETE', `/sessions/${other.id}`, { cookie: me.cookie })).statusCode).toBe(204);
    expect((await call('GET', '/security', { cookie: other.cookie })).statusCode).toBe(401);
    const self = await call('DELETE', `/sessions/${me.id}`, { cookie: me.cookie });
    expect(self.statusCode).toBe(204);
    expect(self.headers['set-cookie']).toBe('tabula_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
  });

  it('refuses a malformed id with 400 and an unknown one with 404', async () => {
    const { cookie } = await session();
    expect((await call('DELETE', '/sessions/not-a-uuid', { cookie })).statusCode).toBe(400);
    expect((await call('DELETE', '/sessions/00000000-0000-4000-8000-000000000000', { cookie })).statusCode).toBe(404);
  });
});

describe('changes with the session cookie', () => {
  it('are refused from another origin and without an Origin, and change nothing', async () => {
    const { cookie } = await session();
    const k = await passkey('one');
    await passkey('two');
    const other = await session();
    const api = await issueTestAccessToken(db, { resource: 'api', name: 'stays' });
    const changes: Array<['PATCH' | 'POST' | 'DELETE', string, object?]> = [
      ['PATCH', `/passkeys/${k.id}`, { name: 'x' }], ['DELETE', `/passkeys/${k.id}`], ['PATCH', `/connections/${api.connectionId}`, { name: 'renamed' }],
      ['POST', `/connections/${api.connectionId}/revoke`], ['DELETE', `/sessions/${other.id}`], ['POST', '/auth/logout'],
    ];
    for (const origin of ['https://evil.example', undefined]) {
      for (const [method, url, payload] of changes) {
        const res = await app.inject({ method, url: `/api${url}`, headers: { cookie, ...(origin ? { origin } : {}) }, ...(payload && { payload }) });
        expect(res.statusCode, `${method} ${url} from ${origin ?? 'no Origin'}`).toBe(403);
      }
    }
    expect(await db.select().from(passkeys)).toHaveLength(2);
    expect(await db.select().from(uiSessions)).toHaveLength(2);
    expect((await db.select().from(oauthConnections)).find((c) => c.id === api.connectionId)).toMatchObject({ name: 'stays', revokedAt: null });
  });
});

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { revokeConnection } from '../../src/auth/oauth/store.js';
import { createSession } from '../../src/auth/sessions.js';
import { settings, uiSessions } from '../../src/db/schema.js';
import { getFile } from '../../src/domain/files.js';
import { buildApp } from '../../src/http/app.js';
import { issueTestAccessToken, seedProject, TEST_PUBLIC_URL, TEST_SECRET, TEST_TOKEN, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
let app: FastifyInstance;
let bare: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ config: testConfig({ publicUrl: TEST_PUBLIC_URL }), db });
  bare = await buildApp({ config: testConfig(), db });
});
afterAll(async () => {
  await app.close();
  await bare.close();
});
beforeEach(() => seedProject(db, 'demo'));

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const MCP_HEADERS = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
const mcp = (target: FastifyInstance, headers: Record<string, string>) =>
  target.inject({ method: 'POST', url: '/mcp', headers: { ...MCP_HEADERS, ...headers }, payload: init });
const bearer = (value: string) => ({ authorization: `Bearer ${value}` });
const sessionCookie = async () => `tabula_session=${(await createSession(db, { userAgent: 'test', now: new Date() })).token}`;
const API_CHALLENGE = `Bearer resource_metadata="${TEST_PUBLIC_URL}/.well-known/oauth-protected-resource/api", scope="api"`;
const MCP_CHALLENGE = `Bearer resource_metadata="${TEST_PUBLIC_URL}/.well-known/oauth-protected-resource/mcp", scope="mcp"`;

describe('/api', () => {
  it('without credentials answers 401 with the resource metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(API_CHALLENGE);
  });

  it('accepts an OAuth token for /api and refuses one for /mcp with invalid_token', async () => {
    const api = await issueTestAccessToken(db, { resource: 'api' });
    const forMcp = await issueTestAccessToken(db, { resource: 'mcp' });
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: bearer(api.value) })).statusCode).toBe(200);
    const refused = await app.inject({ method: 'GET', url: '/api/projects', headers: bearer(forMcp.value) });
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['www-authenticate']).toBe(`${API_CHALLENGE}, error="invalid_token"`);
  });

  it('refuses the token of a revoked connection', async () => {
    const api = await issueTestAccessToken(db, { resource: 'api' });
    await revokeConnection(db, api.connectionId, new Date());
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: bearer(api.value) })).statusCode).toBe(401);
  });

  it('accepts the session cookie, and for changes only from its own origin', async () => {
    const cookie = await sessionCookie();
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } })).statusCode).toBe(200);
    const post = (id: string, headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/projects', headers: { cookie, ...headers }, payload: { id, name: 'P' } });
    expect((await post('p-one', {})).statusCode).toBe(403);
    expect((await post('p-two', { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await post('p-three', { origin: TEST_PUBLIC_URL })).statusCode).toBe(201);
  });

  it('sends the cookie again when the session was renewed', async () => {
    const { session, token } = await createSession(db, { userAgent: 'test', now: new Date() });
    await db.update(uiSessions).set({ lastUsedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(uiSessions.id, session.id));
    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie: `tabula_session=${token}` } });
    expect(res.headers['set-cookie']).toBe(`tabula_session=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict`);
  });

  it('still accepts TABULA_TOKEN and records its use at most once a minute', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: bearer(TEST_TOKEN) })).statusCode).toBe(200);
    const read = async () => (await db.select().from(settings).where(eq(settings.key, 'legacy_token_last_used')))[0]?.value;
    const first = await read();
    expect(first).toEqual({ at: expect.any(String) });
    await app.inject({ method: 'GET', url: '/api/projects', headers: bearer(TEST_TOKEN) });
    expect(await read()).toEqual(first);
  });

  it('labels a file by the connection name, the UI as human and the old token by its header', async () => {
    const put = (headers: Record<string, string>, path: string) =>
      app.inject({ method: 'PUT', url: '/api/projects/demo/files', headers: { origin: TEST_PUBLIC_URL, ...headers }, payload: { path, content: 'x', base_sha256: null } });
    const api = await issueTestAccessToken(db, { resource: 'api', name: 'tabula-cli' });
    expect((await put(bearer(api.value), 'docs/a.md')).statusCode).toBe(200);
    expect((await put({ ...bearer(api.value), 'x-tabula-agent': 'claude-code' }, 'docs/b.md')).statusCode).toBe(200);
    expect((await put({ cookie: await sessionCookie() }, 'docs/c.md')).statusCode).toBe(200);
    expect((await put({ ...bearer(TEST_TOKEN), 'x-tabula-agent': 'cli' }, 'docs/d.md')).statusCode).toBe(200);
    expect((await getFile(db, 'demo', 'docs/a.md')).updatedBy).toBe('tabula-cli');
    expect((await getFile(db, 'demo', 'docs/b.md')).updatedBy).toBe('tabula-cli');
    expect((await getFile(db, 'demo', 'docs/c.md')).updatedBy).toBe('human');
    expect((await getFile(db, 'demo', 'docs/d.md')).updatedBy).toBe('cli');
  });
});

describe('/mcp', () => {
  it('accepts an OAuth token for /mcp only, never the session cookie', async () => {
    const forMcp = await issueTestAccessToken(db, { resource: 'mcp' });
    const forApi = await issueTestAccessToken(db, { resource: 'api' });
    expect((await mcp(app, bearer(forMcp.value))).statusCode).toBe(200);
    const wrong = await mcp(app, bearer(forApi.value));
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['www-authenticate']).toBe(`${MCP_CHALLENGE}, error="invalid_token"`);
    const cookieOnly = await mcp(app, { cookie: await sessionCookie() });
    expect(cookieOnly.statusCode).toBe(401);
    expect(cookieOnly.headers['www-authenticate']).toBe(MCP_CHALLENGE);
  });

  it('still accepts TABULA_TOKEN and the connector secret, and records the connector use', async () => {
    expect((await mcp(app, bearer(TEST_TOKEN))).statusCode).toBe(200);
    const res = await app.inject({ method: 'POST', url: `/mcp/${TEST_SECRET}`, headers: MCP_HEADERS, payload: init });
    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(settings).where(eq(settings.key, 'connector_secret_last_used'));
    expect(row?.value).toEqual({ at: expect.any(String) });
  });
});

describe('without TABULA_PUBLIC_URL', () => {
  it('behaves as before: a bare challenge, and neither OAuth tokens nor cookies', async () => {
    const res = await bare.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    const api = await issueTestAccessToken(db, { resource: 'api' });
    expect((await bare.inject({ method: 'GET', url: '/api/projects', headers: bearer(api.value) })).statusCode).toBe(401);
    expect((await bare.inject({ method: 'GET', url: '/api/projects', headers: { cookie: await sessionCookie() } })).statusCode).toBe(401);
    expect((await bare.inject({ method: 'GET', url: '/api/projects', headers: bearer(TEST_TOKEN) })).statusCode).toBe(200);
  });
});

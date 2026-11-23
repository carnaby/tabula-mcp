import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { revokeConnection } from '../../src/auth/oauth/store.js';
import { createSession } from '../../src/auth/sessions.js';
import { oauthAccessTokens, uiSessions } from '../../src/db/schema.js';
import { getFile } from '../../src/domain/files.js';
import { buildApp } from '../../src/http/app.js';
import { issueTestAccessToken, seedProject, TEST_PUBLIC_URL, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ config: testConfig({ publicUrl: TEST_PUBLIC_URL }), db });
});
afterAll(() => app.close());
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

  it('labels a file by the connection name and the UI as human', async () => {
    const put = (headers: Record<string, string>, path: string) =>
      app.inject({ method: 'PUT', url: '/api/projects/demo/files', headers: { origin: TEST_PUBLIC_URL, ...headers }, payload: { path, content: 'x', base_sha256: null } });
    const api = await issueTestAccessToken(db, { resource: 'api', name: 'tabula-cli' });
    expect((await put(bearer(api.value), 'docs/a.md')).statusCode).toBe(200);
    expect((await put({ ...bearer(api.value), 'x-tabula-agent': 'claude-code' }, 'docs/b.md')).statusCode).toBe(200);
    expect((await put({ cookie: await sessionCookie() }, 'docs/c.md')).statusCode).toBe(200);
    expect((await getFile(db, 'demo', 'docs/a.md')).updatedBy).toBe('tabula-cli');
    expect((await getFile(db, 'demo', 'docs/b.md')).updatedBy).toBe('tabula-cli');
    expect((await getFile(db, 'demo', 'docs/c.md')).updatedBy).toBe('human');
  });

  it('never falls back to the cookie when a bearer token is refused', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: { ...bearer('not-a-token'), cookie: await sessionCookie() } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(`${API_CHALLENGE}, error="invalid_token"`);
  });

  it('answers an expired token with invalid_token on /api and /mcp', async () => {
    const api = await issueTestAccessToken(db, { resource: 'api' });
    const forMcp = await issueTestAccessToken(db, { resource: 'mcp' });
    await db.update(oauthAccessTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    const a = await app.inject({ method: 'GET', url: '/api/projects', headers: bearer(api.value) });
    expect(a.statusCode).toBe(401);
    expect(a.headers['www-authenticate']).toBe(`${API_CHALLENGE}, error="invalid_token"`);
    const m = await mcp(app, bearer(forMcp.value));
    expect(m.statusCode).toBe(401);
    expect(m.headers['www-authenticate']).toBe(`${MCP_CHALLENGE}, error="invalid_token"`);
  });

  it('refuses PUT, PATCH and DELETE with the cookie but without an Origin', async () => {
    const cookie = await sessionCookie();
    const other = await createSession(db, { userAgent: 'other', now: new Date() });
    const conn = await issueTestAccessToken(db, { resource: 'api', name: 'keep-me' });
    const changes = [
      { method: 'PUT' as const, url: '/api/projects/demo/files', payload: { path: 'docs/a.md', content: 'x', base_sha256: null } },
      { method: 'PATCH' as const, url: `/api/connections/${conn.connectionId}`, payload: { name: 'renamed' } },
      { method: 'DELETE' as const, url: `/api/sessions/${other.session.id}` },
    ];
    for (const c of changes) {
      const res = await app.inject({ method: c.method, url: c.url, headers: { cookie }, ...(c.payload && { payload: c.payload }) });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
    }
    await expect(getFile(db, 'demo', 'docs/a.md')).rejects.toMatchObject({ code: 'not_found' });
    expect((await db.select().from(uiSessions)).map((s) => s.id)).toContain(other.session.id);
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
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { oauthAccessTokens } from '../../src/db/schema.js';
import { createMessageToken } from '../../src/domain/message-tokens.js';
import { buildApp } from '../../src/http/app.js';
import {
  issueTestAccessToken, seedProject, TEST_APP_TOKEN, TEST_MCP_TOKEN, TEST_PUBLIC_URL, TEST_TOKEN, testConfig, useTestAppToken, useTestDb,
  useTestTokens,
} from '../helpers.js';
import { signedInCookie } from '../oauth-flow.js';

const db = useTestDb();
useTestTokens(db);
useTestAppToken(db);
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config: testConfig(), db });
});
afterAll(() => app.close());

const U = TEST_PUBLIC_URL;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const get = (url: string, headers: Record<string, string> = bearer(TEST_APP_TOKEN)) => app.inject({ method: 'GET', url, headers });

describe('GET /app-api/v1/projects', () => {
  it('lists projects by slug, name and description, without global', async () => {
    await seedProject(db, 'beta');
    const res = await get('/app-api/v1/projects');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ slug: 'beta', name: 'beta', description: 'beta project' }] });
  });
});

describe('authentication', () => {
  const META = `resource_metadata="${U}/.well-known/oauth-protected-resource/app-api", scope="app"`;

  it('answers no token with 401 and the challenge of /app-api', async () => {
    const res = await get('/app-api/v1/projects', {});
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(`Bearer ${META}`);
    expect(res.json()).toEqual({ error: 'unauthorized', message: expect.any(String) });
  });

  it('answers an unknown and an expired token with invalid_token, so the app refreshes', async () => {
    const expired = await issueTestAccessToken(db, { resource: 'app', name: 'klara-2' });
    await db.update(oauthAccessTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(oauthAccessTokens.connectionId, expired.connectionId));
    for (const token of ['x'.repeat(32), expired.value]) {
      const res = await get('/app-api/v1/projects', bearer(token));
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe(`Bearer ${META}, error="invalid_token"`);
      expect(res.json().error).toBe('unauthorized');
    }
  });

  describe('isolation of credentials and resources', () => {
    const MCP_HEADERS = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
    type Credential = 'app' | 'mcp' | 'api' | 'inbox' | 'session';
    type Target = '/app-api' | '/api' | '/mcp' | '/inbox-api';
    /** What each credential opens; every other cell of the matrix is 401. */
    const OPENS: Record<Credential, Target> = { app: '/app-api', mcp: '/mcp', api: '/api', inbox: '/inbox-api', session: '/api' };
    const TARGETS: Target[] = ['/app-api', '/api', '/mcp', '/inbox-api'];
    let inboxToken = '';
    let cookie = '';
    beforeEach(async () => {
      await seedProject(db, 'beta');
      inboxToken = (await createMessageToken(db, { projectId: 'beta', name: 'reader' })).value;
      cookie = await signedInCookie(db);
    });
    const credential = (c: Credential): Record<string, string> =>
      c === 'session' ? { cookie } : bearer({ app: TEST_APP_TOKEN, mcp: TEST_MCP_TOKEN, api: TEST_TOKEN, inbox: inboxToken }[c]);
    const call = (t: Target, headers: Record<string, string>) => {
      if (t === '/mcp') return app.inject({ method: 'POST', url: '/mcp', headers: { ...MCP_HEADERS, ...headers }, payload: init });
      const url = { '/app-api': '/app-api/v1/projects', '/api': '/api/projects', '/inbox-api': '/inbox-api/v1/messages' }[t];
      return app.inject({ method: 'GET', url, headers });
    };

    it.each((Object.keys(OPENS) as Credential[]).flatMap((c) => TARGETS.map((t) => [c, t] as const)))('%s on %s', async (c, t) => {
      expect((await call(t, credential(c))).statusCode).toBe(OPENS[c] === t ? 200 : 401);
    });
  });
});

describe('unknown paths', () => {
  it('answer 404 not_found in the API shape after authentication, also where v2 will be', async () => {
    for (const [method, url] of [
      ['GET', '/app-api/v1/nope'],
      ['GET', '/app-api/v2/projects'],
      ['POST', '/app-api/v1/messages/00000000-0000-4000-8000-000000000000/reply'],
    ] as const) {
      const res = await app.inject({ method, url, headers: bearer(TEST_APP_TOKEN) });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found', message: expect.any(String) });
    }
    expect((await get('/app-api/v1/nope', {})).statusCode).toBe(401);
  });

  it('stay in the API shape when the web UI is served, whose catch-all takes every other GET', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabula-web-'));
    writeFileSync(join(dir, 'index.html'), '<title>Tabula</title>');
    const served = await buildApp({ config: testConfig({ webDist: dir }), db });
    try {
      for (const url of ['/app-api', '/app-api/', '/app-api/v1/nope', '/app-api/v2/projects']) {
        const anonymous = await served.inject({ method: 'GET', url });
        expect(anonymous.statusCode, url).toBe(401);
        expect(anonymous.headers['www-authenticate'], url).toMatch(/oauth-protected-resource\/app-api/);
        expect(anonymous.json()).toEqual({ error: 'unauthorized', message: expect.any(String) });
        const known = await served.inject({ method: 'GET', url, headers: bearer(TEST_APP_TOKEN) });
        expect(known.statusCode, url).toBe(404);
        expect(known.json()).toEqual({ error: 'not_found', message: expect.any(String) });
        expect((await served.inject({ method: 'HEAD', url })).statusCode, url).toBe(401);
        expect((await served.inject({ method: 'HEAD', url, headers: bearer(TEST_APP_TOKEN) })).statusCode, url).toBe(404);
      }
      expect((await served.inject({ method: 'GET', url: '/' })).body).toContain('<title>Tabula</title>');
    } finally {
      await served.close();
    }
  });
});

describe('the log', () => {
  it('never holds a token', async () => {
    const logs: string[] = [];
    const prevLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    const logged = await buildApp({ config: testConfig(), db, logStream: { write: (m) => void logs.push(m) } });
    process.env.LOG_LEVEL = prevLevel;
    try {
      await logged.inject({ method: 'GET', url: '/app-api/v1/projects', headers: bearer(TEST_APP_TOKEN) });
      await logged.inject({ method: 'GET', url: '/app-api/v1/nope', headers: bearer('wrong-token-value-0123456789abcdef') });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.join()).not.toContain(TEST_APP_TOKEN);
      expect(logs.join()).not.toContain('wrong-token-value');
    } finally {
      await logged.close();
    }
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configWarnings, loadConfig } from '../../src/config.js';
import { buildApp } from '../../src/http/app.js';
import { TEST_MCP_TOKEN, TEST_PUBLIC_URL, testConfig, useTestDb, useTestTokens } from '../helpers.js';

const db = useTestDb();
useTestTokens(db);
const OLD_TOKEN = 'o'.repeat(32);
const OLD_SECRET = 's'.repeat(32);
const logs: string[] = [];
let app: FastifyInstance;
beforeAll(async () => {
  const prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  app = await buildApp({ config: testConfig(), db, logStream: { write: (m) => void logs.push(m) } });
  process.env.LOG_LEVEL = prevLevel;
});
afterAll(() => app.close());

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const MCP_HEADERS = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };

describe('the shared token is gone', () => {
  it('requires TABULA_PUBLIC_URL and only warns about the retired variables', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow(/TABULA_PUBLIC_URL is required/);
    const env = { DATABASE_URL: 'postgres://x', TABULA_PUBLIC_URL: TEST_PUBLIC_URL, TABULA_TOKEN: OLD_TOKEN, TABULA_CONNECTOR_SECRET: OLD_SECRET };
    const config = loadConfig(env);
    expect(JSON.stringify(config)).not.toContain(OLD_TOKEN);
    expect(configWarnings(env)).toEqual([
      'TABULA_TOKEN is no longer used and is ignored: sign in with a passkey and connect apps with OAuth; remove it from .env',
      'TABULA_CONNECTOR_SECRET is no longer used and is ignored: claude.ai connects to <TABULA_PUBLIC_URL>/mcp with OAuth; remove it from .env',
    ]);
  });

  it('refuses a token that is not an OAuth access token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${OLD_TOKEN}` } })).statusCode).toBe(401);
    const mcp = (token: string) => app.inject({ method: 'POST', url: '/mcp', headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` }, payload: init });
    expect((await mcp(OLD_TOKEN)).statusCode).toBe(401);
    expect((await mcp(TEST_MCP_TOKEN)).statusCode).toBe(200);
  });

  it('answers an old connector address with 404 and keeps the secret out of the log', async () => {
    logs.length = 0;
    const probes = [
      ['POST', `/mcp/${OLD_SECRET}`],
      ['GET', `/mcp/${OLD_SECRET}`],
      ['DELETE', `/mcp/${OLD_SECRET}`],
      ['GET', `/MCP/${OLD_SECRET}`],
      ['POST', `/mcp/${OLD_SECRET}/`],
      ['GET', `//mcp/${OLD_SECRET}`],
    ] as const;
    // As an MCP client sends them: a content type only with a body (GET opens the SSE stream, DELETE ends the session).
    for (const [method, url] of probes) {
      const res = await app.inject(
        method === 'POST' ? { method, url, headers: MCP_HEADERS, payload: init } : { method, url, headers: { accept: MCP_HEADERS.accept } },
      );
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join()).not.toContain(OLD_SECRET);
  });

  it('has no legacy form for adding a passkey', async () => {
    const res = await app.inject({
      method: 'POST', url: '/passkey/add', headers: { origin: TEST_PUBLIC_URL, 'content-type': 'application/x-www-form-urlencoded' }, payload: `legacy_token=${OLD_TOKEN}`,
    });
    expect(res.statusCode).toBe(404);
  });
});

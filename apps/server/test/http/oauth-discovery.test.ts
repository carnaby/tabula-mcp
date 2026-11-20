import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauthClients } from '../../src/db/schema.js';
import { buildApp } from '../../src/http/app.js';
import { TEST_PUBLIC_URL, testConfig, useTestDb } from '../helpers.js';

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

const U = TEST_PUBLIC_URL;
let address = 0;
/** Each registration from its own address unless one is given: the hourly limit is tested on its own. */
const register = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/oauth/register', payload: payload as object, headers: { 'x-forwarded-for': `198.51.100.${++address % 250}`, ...headers } });

describe('discovery', () => {
  it('describes both protected resources, /mcp also at the bare path', async () => {
    for (const [path, kind] of [['/.well-known/oauth-protected-resource/mcp', 'mcp'], ['/.well-known/oauth-protected-resource', 'mcp'], ['/.well-known/oauth-protected-resource/api', 'api']]) {
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode, path).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      expect(res.json()).toEqual({ resource: `${U}/${kind}`, authorization_servers: [U], scopes_supported: [kind], bearer_methods_supported: ['header'] });
    }
  });

  it('describes the authorization server', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.json()).toEqual({
      issuer: U,
      authorization_endpoint: `${U}/oauth/authorize`,
      token_endpoint: `${U}/oauth/token`,
      registration_endpoint: `${U}/oauth/register`,
      revocation_endpoint: `${U}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp', 'api', 'offline_access'],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('does not exist without TABULA_PUBLIC_URL', async () => {
    for (const url of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
      expect((await bare.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    expect((await bare.inject({ method: 'POST', url: '/oauth/register', payload: {} })).statusCode).toBe(404);
  });
});

describe('dynamic client registration', () => {
  it('registers a public client and echoes what it accepted', async () => {
    const res = await register({ client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none', logo_uri: 'https://x.example/l.png' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toEqual({
      client_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      client_id_issued_at: expect.any(Number),
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(await db.select().from(oauthClients)).toHaveLength(1);
  });

  it('omits client_name when there is none', async () => {
    expect((await register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })).json()).not.toHaveProperty('client_name');
  });

  it('refuses metadata it cannot honour', async () => {
    const cases: Array<[unknown, string]> = [
      [{}, 'invalid_redirect_uri'],
      [{ redirect_uris: ['myapp://cb'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['http://client.example.com/cb'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['https://client.example.com/cb#x'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: Array.from({ length: 6 }, (_, i) => `https://client.example.com/${i}`) }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['https://c.example.com/cb'], token_endpoint_auth_method: 'client_secret_basic' }, 'invalid_client_metadata'],
      [{ redirect_uris: ['https://c.example.com/cb'], grant_types: ['client_credentials'] }, 'invalid_client_metadata'],
      [{ redirect_uris: ['https://c.example.com/cb'], response_types: ['token'] }, 'invalid_client_metadata'],
      [{ redirect_uris: ['https://c.example.com/cb'], client_name: `Claude${String.fromCharCode(0x202e)}` }, 'invalid_client_metadata'],
      [{ redirect_uris: ['https://c.example.com/cb'], client_name: 'x'.repeat(101) }, 'invalid_client_metadata'],
      [[1, 2], 'invalid_client_metadata'],
    ];
    for (const [payload, error] of cases) {
      const res = await register(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toBe(error);
    }
    const form = await app.inject({ method: 'POST', url: '/oauth/register', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'redirect_uris=x' });
    expect(form.statusCode).toBe(400);
    expect(form.json().error).toBe('invalid_client_metadata');
  });

  it('allows ten registrations an hour per address', async () => {
    const from = { 'x-forwarded-for': '203.0.113.70' };
    for (let i = 0; i < 10; i++) expect((await register({ redirect_uris: ['https://c.example.com/cb'] }, from)).statusCode).toBe(201);
    const res = await register({ redirect_uris: ['https://c.example.com/cb'] }, from);
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('slow_down');
  });

  it('stops at 1000 clients nobody approved', async () => {
    await db.execute(sql`INSERT INTO oauth_clients (redirect_uris) SELECT ARRAY['https://c.example.com/cb'] FROM generate_series(1, 1000)`);
    const res = await register({ redirect_uris: ['https://c.example.com/cb'] });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('temporarily_unavailable');
  });
});

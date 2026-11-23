import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { challenge } from '../../src/auth/authenticate.js';
import { authenticateAccessToken } from '../../src/auth/oauth/store.js';
import { authSettings } from '../../src/auth/settings.js';
import { oauthConnections } from '../../src/db/schema.js';
import { buildApp } from '../../src/http/app.js';
import { TEST_PUBLIC_URL, testConfig, useTestDb } from '../helpers.js';
import { authorizeQuery, newPkce, obtainCode, registerClient, signedInCookie } from '../oauth-flow.js';

// Registers clients over HTTP (10 an hour per address and app instance): such tests stay in this file.
const db = useTestDb();
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config: testConfig(), db });
});
afterAll(() => app.close());

const U = TEST_PUBLIC_URL;
const APP_QUERY = { resource: `${U}/app-api`, scope: 'app offline_access' };
const form = (payload: Record<string, string>) =>
  app.inject({
    method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(payload).toString(),
  });

/** Consent and code exchange for /app-api: the tokens and the flow they came from. */
async function connectApp(name = 'klara') {
  const flow = await obtainCode(app, db, { query: APP_QUERY, name });
  const res = await form({
    grant_type: 'authorization_code', code: flow.code, redirect_uri: flow.redirectUri, client_id: flow.clientId, code_verifier: flow.pkce.verifier,
    resource: `${U}/app-api`,
  });
  expect(res.statusCode).toBe(200);
  return { ...flow, tokens: res.json() as { access_token: string; refresh_token: string; scope: string } };
}

describe('the OAuth resource app', () => {
  it('is described at the path of /app-api', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/app-api' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resource: `${U}/app-api`, authorization_servers: [U], scopes_supported: ['app'], bearer_methods_supported: ['header'] });
    expect((await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/app' })).statusCode).toBe(404);
  });

  it('names the App API on the consent page', async () => {
    const clientId = await registerClient(app, { client_name: 'Klara' });
    const page = await app.inject({
      method: 'GET', url: `/oauth/authorize?${authorizeQuery(clientId, newPkce(), APP_QUERY)}`, headers: { cookie: await signedInCookie(db) },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('App API: send messages to projects, save thoughts, notes and reports');
  });

  it('issues tokens bound to /app-api that refresh for it and open nothing else', async () => {
    const c = await connectApp();
    expect(c.tokens.scope).toBe('app offline_access');
    const [conn] = await db.select().from(oauthConnections);
    expect(conn).toMatchObject({ name: 'klara', resource: 'app', scope: 'app offline_access', revokedAt: null });
    const now = new Date();
    expect(await authenticateAccessToken(db, c.tokens.access_token, 'app', now)).toMatchObject({ ok: true, name: 'klara' });
    expect(await authenticateAccessToken(db, c.tokens.access_token, 'mcp', now)).toEqual({ ok: false });
    expect(await authenticateAccessToken(db, c.tokens.access_token, 'api', now)).toEqual({ ok: false });
    const refreshed = await form({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.clientId, resource: `${U}/app-api` });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().scope).toBe('app offline_access');
    const elsewhere = await form({ grant_type: 'refresh_token', refresh_token: refreshed.json().refresh_token, client_id: c.clientId, resource: `${U}/mcp` });
    expect(elsewhere.json().error).toBe('invalid_target');
  });

  it('points a refused request to the metadata of /app-api', () => {
    expect(challenge(authSettings({ publicUrl: U }), 'app', true)).toBe(
      `Bearer resource_metadata="${U}/.well-known/oauth-protected-resource/app-api", scope="app", error="invalid_token"`,
    );
  });
});

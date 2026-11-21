import { eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauthAccessTokens, oauthConnections, oauthRefreshTokens } from '../../src/db/schema.js';
import { buildApp } from '../../src/http/app.js';
import { TEST_PUBLIC_URL, testConfig, useTestDb } from '../helpers.js';
import { newPkce, obtainCode, registerClient } from '../oauth-flow.js';

const db = useTestDb();
const logs: string[] = [];
let app: FastifyInstance;
beforeAll(async () => {
  const prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  app = await buildApp({ config: testConfig({ publicUrl: TEST_PUBLIC_URL }), db, logStream: { write: (m) => void logs.push(m) } });
  process.env.LOG_LEVEL = prevLevel;
});
afterAll(() => app.close());

let address = 0;
const form = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST', url, payload: new URLSearchParams(body).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `198.18.0.${++address % 250}`, ...headers },
  });
type Flow = Awaited<ReturnType<typeof obtainCode>>;
const exchange = (f: Flow, overrides: Record<string, string> = {}) =>
  form('/oauth/token', { grant_type: 'authorization_code', code: f.code, redirect_uri: f.redirectUri, client_id: f.clientId, code_verifier: f.pkce.verifier, resource: `${TEST_PUBLIC_URL}/mcp`, ...overrides });
const refresh = (refreshToken: string, clientId: string, overrides: Record<string, string> = {}) =>
  form('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, ...overrides });
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const callMcp = (token: string) =>
  app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: init });
const callApi = (token: string) => app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${token}` } });
const live = async () => (await db.select().from(oauthConnections)).filter((c) => c.revokedAt === null);
/** Rows of issued tokens: a refusal must leave both counts as they were. */
const issued = async () => ({
  access: (await db.select().from(oauthAccessTokens)).length,
  refresh: (await db.select().from(oauthRefreshTokens)).length,
});

const lockWaits = async () =>
  (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`))[0]!.n;

/**
 * `n` requests made truly simultaneous: another transaction holds every row of `table`, the requests start, and the
 * rows are released only once all of them wait on a lock. Without the race being forced, inject tends to serialise them.
 */
async function racing<T>(table: 'oauth_codes' | 'oauth_refresh_tokens', n: number, start: () => Promise<T>): Promise<T[]> {
  let results: Promise<T[]> | undefined;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} FOR UPDATE`);
    results = Promise.all(Array.from({ length: n }, start));
    const deadline = Date.now() + 5000;
    while ((await lockWaits()) < n) {
      if (Date.now() > deadline) throw new Error('the requests never queued on the lock');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  return results!;
}

describe('authorization_code', () => {
  it('issues an access token for the resource and a refresh token, uncached', async () => {
    const flow = await obtainCode(app, db);
    const res = await exchange(flow);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.pragma).toBe('no-cache');
    const body = res.json();
    expect(body).toEqual({ access_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), token_type: 'Bearer', expires_in: 3600, refresh_token: expect.any(String), scope: 'mcp offline_access' });
    expect((await callMcp(body.access_token)).statusCode).toBe(200);
    expect((await callApi(body.access_token)).statusCode).toBe(401);
  });

  it('binds an /api code to /api', async () => {
    const flow = await obtainCode(app, db, { query: { resource: `${TEST_PUBLIC_URL}/api`, scope: 'api offline_access' } });
    expect((await exchange(flow)).json().error).toBe('invalid_target');
    const res = await exchange(flow, { resource: `${TEST_PUBLIC_URL}/api` });
    expect(res.json().scope).toBe('api offline_access');
    expect((await callApi(res.json().access_token)).statusCode).toBe(200);
    expect((await callMcp(res.json().access_token)).statusCode).toBe(401);
  });

  it('a code used twice ends the whole connection', async () => {
    const flow = await obtainCode(app, db);
    const first = (await exchange(flow)).json();
    const again = await exchange(flow);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('invalid_grant');
    expect(await live()).toHaveLength(0);
    const after = await callMcp(first.access_token);
    expect(after.statusCode).toBe(401);
    expect(after.headers['www-authenticate']).toContain('error="invalid_token"');
    expect((await refresh(first.refresh_token, flow.clientId)).json().error).toBe('invalid_grant');
  });

  it('a code presented twice at once is redeemed once, and the second presentation ends the connection', async () => {
    const flow = await obtainCode(app, db);
    const results = await racing('oauth_codes', 2, () => exchange(flow));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(results.find((r) => r.statusCode === 400)!.json().error).toBe('invalid_grant');
    expect(await issued()).toEqual({ access: 1, refresh: 1 });
    expect(await live()).toHaveLength(0);
  });

  it('refuses a wrong verifier, another redirect, an unknown or malformed client, a foreign resource and an expired code', async () => {
    const flow = await obtainCode(app, db);
    expect((await exchange(flow, { code_verifier: newPkce().verifier })).json().error).toBe('invalid_grant');
    expect((await exchange(flow, { redirect_uri: 'https://claude.ai/other' })).json().error).toBe('invalid_grant');
    const unknown = await exchange(flow, { client_id: '00000000-0000-4000-8000-000000000000' });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe('invalid_client');
    expect((await exchange(flow, { client_id: 'not-a-uuid' })).json().error).toBe('invalid_client');
    expect((await exchange(flow, { client_id: await registerClient(app) })).json().error).toBe('invalid_grant');
    expect((await exchange(flow, { resource: 'https://other.example/mcp' })).json().error).toBe('invalid_target');
    // None of the refusals spent the code.
    expect((await exchange(flow)).statusCode).toBe(200);

    const late = await obtainCode(app, db);
    await db.execute(sql`UPDATE oauth_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    expect((await exchange(late)).json().error).toBe('invalid_grant');
  });

  it("a code presented by another registered client issues nothing and stays the first client's", async () => {
    const flow = await obtainCode(app, db);
    const before = await issued();
    const foreign = await exchange(flow, { client_id: await registerClient(app) });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json()).toEqual({ error: 'invalid_grant', error_description: expect.any(String) });
    expect(await issued()).toEqual(before);
    expect(await live()).toHaveLength(1);
    expect((await exchange(flow)).statusCode).toBe(200);
  });

  it('binds the code to the loopback port presented at /oauth/authorize', async () => {
    const clientId = await registerClient(app, { client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1/callback'] });
    const flow = await obtainCode(app, db, { clientId, query: { redirect_uri: 'http://127.0.0.1:53111/callback' } });
    expect((await exchange(flow, { redirect_uri: 'http://127.0.0.1:53112/callback' })).json().error).toBe('invalid_grant');
    expect((await exchange(flow)).statusCode).toBe(200);
  });

  it('refuses a repeated parameter, a JSON body and an unknown grant', async () => {
    const flow = await obtainCode(app, db);
    const body = `grant_type=authorization_code&code=${flow.code}&code=other&redirect_uri=${encodeURIComponent(flow.redirectUri)}&client_id=${flow.clientId}&code_verifier=${flow.pkce.verifier}`;
    const repeated = await app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: body });
    expect(repeated.json().error).toBe('invalid_request');
    const json = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', code: flow.code } });
    expect(json.json().error).toBe('invalid_request');
    expect((await form('/oauth/token', { grant_type: 'client_credentials' })).json().error).toBe('unsupported_grant_type');
    expect((await form('/oauth/token', { grant_type: 'authorization_code' })).json().error).toBe('invalid_request');
  });

  it('answers malformed codes, verifiers, tokens and ids as refusals, never as a server error', async () => {
    const nul = String.fromCharCode(0);
    const flow = await obtainCode(app, db);
    for (const code of [`a${nul}b`, 'ž'.repeat(60), "'; SELECT 1; --", '%']) {
      const res = await exchange(flow, { code });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
    }
    for (const verifier of [nul, `${flow.pkce.verifier}${nul}`, 'ž'.repeat(60)]) {
      expect((await exchange(flow, { code_verifier: verifier })).json().error).toBe('invalid_grant');
    }
    expect((await exchange(flow, { redirect_uri: `${flow.redirectUri}${nul}` })).json().error).toBe('invalid_grant');
    expect((await exchange(flow, { resource: `${TEST_PUBLIC_URL}/mcp${nul}` })).json().error).toBe('invalid_target');
    for (const clientId of [`${flow.clientId}${nul}`, 'ž', `${flow.clientId}x`]) {
      const res = await exchange(flow, { client_id: clientId });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalid_client');
    }
    expect((await refresh(`r${nul}`, flow.clientId)).json().error).toBe('invalid_grant');
    expect((await refresh('r', `c${nul}`)).statusCode).toBe(401);
    expect((await refresh('r', flow.clientId, { scope: `mcp${nul}` })).json().error).toBe('invalid_grant');
    const revocations: Array<Record<string, string>> = [
      { token: `t${nul}` }, { token: 't', client_id: `c${nul}` }, { token: 't', client_id: 'not-a-uuid' }, { token: 't', token_type_hint: 'nonsense' },
    ];
    for (const body of revocations) expect((await form('/oauth/revoke', body)).statusCode).toBe(200);
    // The code survived all of it.
    expect((await exchange(flow)).statusCode).toBe(200);
  });
});

describe('refresh_token', () => {
  it('rotates the pair; a replay within ten seconds is refused without ending the connection', async () => {
    const flow = await obtainCode(app, db);
    const first = (await exchange(flow)).json();
    const second = await refresh(first.refresh_token, flow.clientId);
    expect(second.statusCode).toBe(200);
    expect(second.json().refresh_token).not.toBe(first.refresh_token);
    const replay = await refresh(first.refresh_token, flow.clientId);
    expect(replay.json().error).toBe('invalid_grant');
    expect(await live()).toHaveLength(1);
    expect((await callMcp(second.json().access_token)).statusCode).toBe(200);
  });

  it('two processes refreshing with the same token at once: one rotates, the others are refused, the connection lives', async () => {
    const flow = await obtainCode(app, db);
    const first = (await exchange(flow)).json();
    const before = await issued();
    const results = await racing('oauth_refresh_tokens', 3, () => refresh(first.refresh_token, flow.clientId));
    const won = results.filter((r) => r.statusCode === 200);
    expect(won).toHaveLength(1);
    for (const lost of results.filter((r) => r.statusCode !== 200)) expect(lost.json().error).toBe('invalid_grant');
    expect(await issued()).toEqual({ access: before.access + 1, refresh: before.refresh + 1 });
    expect(await live()).toHaveLength(1);
    const pair = won[0]!.json();
    expect((await callMcp(pair.access_token)).statusCode).toBe(200);
    expect((await refresh(pair.refresh_token, flow.clientId)).statusCode).toBe(200);
  });

  it('a replay after ten seconds ends the whole connection', async () => {
    const flow = await obtainCode(app, db);
    const first = (await exchange(flow)).json();
    const second = (await refresh(first.refresh_token, flow.clientId)).json();
    await db.update(oauthRefreshTokens).set({ replacedAt: new Date(Date.now() - 11_000) });
    expect((await refresh(first.refresh_token, flow.clientId)).json().error).toBe('invalid_grant');
    expect(await live()).toHaveLength(0);
    expect((await callMcp(second.access_token)).statusCode).toBe(401);
  });

  it('a replay while a revocation ends the same connection is refused, never a server error', async () => {
    const flow = await obtainCode(app, db);
    const first = (await exchange(flow)).json();
    expect((await refresh(first.refresh_token, flow.clientId)).statusCode).toBe(200);
    await db.update(oauthRefreshTokens).set({ replacedAt: new Date(Date.now() - 11_000) }).where(isNotNull(oauthRefreshTokens.replacedAt));
    const [connection] = await live();
    let replay: ReturnType<typeof refresh> | undefined;
    await db.transaction(async (tx) => {
      // A revocation's first step, as revokeConnection takes it: the connection row.
      await tx.update(oauthConnections).set({ revokedAt: new Date() }).where(eq(oauthConnections.id, connection!.id));
      replay = refresh(first.refresh_token, flow.clientId);
      const deadline = Date.now() + 5000;
      while ((await lockWaits()) < 1) {
        if (Date.now() > deadline) throw new Error('the replay never waited for the connection row');
        await new Promise((r) => setTimeout(r, 10));
      }
      // Its next step: the connection's refresh tokens, one of which the replay holds if it revokes inside its grant.
      await tx.update(oauthRefreshTokens).set({ expiresAt: new Date() }).where(eq(oauthRefreshTokens.connectionId, connection!.id));
    });
    const res = await replay!;
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    expect(await live()).toHaveLength(0);
    // The test's transaction left the access tokens alone: only the replay's own revocation can have ended them.
    const tokens = await db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.connectionId, connection!.id));
    expect(tokens).toHaveLength(2);
    expect(tokens.filter((t) => t.revokedAt === null)).toEqual([]);
  });

  it('may narrow the scope, never widen it, and only for its own resource and client', async () => {
    const flow = await obtainCode(app, db);
    const first = (await exchange(flow)).json();
    expect((await refresh(first.refresh_token, flow.clientId, { scope: 'mcp api' })).json().error).toBe('invalid_scope');
    expect((await refresh(first.refresh_token, flow.clientId, { resource: `${TEST_PUBLIC_URL}/api` })).json().error).toBe('invalid_target');
    expect((await refresh(first.refresh_token, await registerClient(app))).json().error).toBe('invalid_grant');
    const narrowed = await refresh(first.refresh_token, flow.clientId, { scope: 'mcp' });
    expect(narrowed.json().scope).toBe('mcp');
  });

  it("a refresh token presented by another registered client issues nothing and stays the first client's", async () => {
    const flow = await obtainCode(app, db);
    const first = (await exchange(flow)).json();
    const before = await issued();
    const foreign = await refresh(first.refresh_token, await registerClient(app));
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error).toBe('invalid_grant');
    expect(await issued()).toEqual(before);
    expect(await live()).toHaveLength(1);
    expect((await refresh(first.refresh_token, flow.clientId)).statusCode).toBe(200);
  });

  it('refuses a refresh for a revoked connection', async () => {
    const flow = await obtainCode(app, db);
    const first = (await exchange(flow)).json();
    // Only the connection row: the refresh token itself still looks live.
    await db.update(oauthConnections).set({ revokedAt: new Date() }).where(eq(oauthConnections.clientId, flow.clientId));
    const before = await issued();
    expect((await refresh(first.refresh_token, flow.clientId)).json().error).toBe('invalid_grant');
    expect(await issued()).toEqual(before);
  });
});

describe('revoke', () => {
  it('a refresh token ends its connection; an access token only itself; anything else changes nothing', async () => {
    const flow = await obtainCode(app, db);
    const pair = (await exchange(flow)).json();
    const other = (await exchange(await obtainCode(app, db))).json();
    expect((await form('/oauth/revoke', { token: 'unknown' })).statusCode).toBe(200);
    expect((await form('/oauth/revoke', { token: other.access_token, client_id: flow.clientId })).statusCode).toBe(200);
    expect((await callMcp(other.access_token)).statusCode).toBe(200);
    expect((await form('/oauth/revoke', { token: other.access_token })).statusCode).toBe(200);
    expect((await callMcp(other.access_token)).statusCode).toBe(401);
    expect(await live()).toHaveLength(2);
    expect((await form('/oauth/revoke', { token: pair.refresh_token, client_id: flow.clientId })).statusCode).toBe(200);
    expect((await callMcp(pair.access_token)).statusCode).toBe(401);
    expect(await live()).toHaveLength(1);
    expect((await form('/oauth/revoke', {})).json().error).toBe('invalid_request');
  });
});

describe('limits and secrets', () => {
  it('allows 30 token requests a minute per address', async () => {
    const from = { 'x-forwarded-for': '203.0.113.80' };
    for (let i = 0; i < 30; i++) expect((await form('/oauth/token', { grant_type: 'nope' }, from)).statusCode).toBe(400);
    const res = await form('/oauth/token', { grant_type: 'nope' }, from);
    expect(res.json().error).toBe('slow_down');
    expect(res.headers['retry-after']).toBe('60');
  });

  it('never stores or logs a code, verifier or token', async () => {
    logs.length = 0;
    const flow = await obtainCode(app, db);
    const pair = (await exchange(flow)).json();
    const next = (await refresh(pair.refresh_token, flow.clientId)).json();
    const secrets = [flow.code, flow.pkce.verifier, pair.access_token, pair.refresh_token, next.access_token, next.refresh_token];
    const stored = JSON.stringify([await db.select().from(oauthAccessTokens), await db.select().from(oauthRefreshTokens)]);
    for (const s of secrets) {
      expect(logs.join()).not.toContain(s);
      expect(stored).not.toContain(s);
    }
    expect(logs.length).toBeGreaterThan(0);
  });
});

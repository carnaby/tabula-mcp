import { eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticateAccessToken, issueTokenPair } from '../../src/auth/oauth/store.js';
import { oauthConnections, oauthPending } from '../../src/db/schema.js';
import { buildApp } from '../../src/http/app.js';
import { TEST_PUBLIC_URL, testConfig, useTestDb } from '../helpers.js';
import { authorizeQuery, CALLBACK, decide, newPkce, obtainCode, pendingOf, registerClient, signedInCookie } from '../oauth-flow.js';

const db = useTestDb();
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config: testConfig({ publicUrl: TEST_PUBLIC_URL }), db });
});
afterAll(() => app.close());

const authorize = (query: string, cookie?: string) =>
  app.inject({ method: 'GET', url: `/oauth/authorize?${query}`, headers: cookie ? { cookie } : {} });

describe('GET /oauth/authorize', () => {
  it('answers an unknown client or a foreign redirect with a page, never a redirect', async () => {
    const id = await registerClient(app);
    for (const query of [
      authorizeQuery('00000000-0000-4000-8000-000000000000', newPkce()),
      authorizeQuery('not-a-uuid', newPkce()),
      authorizeQuery(id, newPkce(), { redirect_uri: 'https://evil.example/cb' }),
      authorizeQuery(id, newPkce(), { redirect_uri: undefined }),
    ]) {
      const res = await authorize(query, await signedInCookie(db));
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
      expect(res.body).toContain('Connection refused');
    }
  });

  it('refuses a bad request before anyone signs in, with the error code on the page', async () => {
    const id = await registerClient(app);
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: undefined }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
      [{ scope: 'api' }, 'invalid_scope'],
      [{ resource: `${TEST_PUBLIC_URL}/api`, scope: 'mcp' }, 'invalid_scope'],
      [{ scope: 'admin' }, 'invalid_scope'],
    ];
    for (const [overrides, error] of cases) {
      const res = await authorize(authorizeQuery(id, newPkce(), overrides));
      expect(res.statusCode, error).toBe(400);
      expect(res.body).toContain(`(${error})`);
    }
    const twice = await authorize(`${authorizeQuery(id, newPkce())}&state=again`);
    expect(twice.body).toContain('(invalid_request)');
  });

  it('accepts a loopback redirect on another port than registered', async () => {
    const id = await registerClient(app, { client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1/callback'] });
    const res = await authorize(authorizeQuery(id, newPkce(), { redirect_uri: 'http://127.0.0.1:53111/callback' }), await signedInCookie(db));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('an app on this computer');
    expect(res.body).toContain('Approve only if you are starting it yourself right now');
    expect(res.body).toContain('value="claude-code"');
  });

  it('sends a visitor without a fresh passkey check to sign in, and back', async () => {
    const query = authorizeQuery(await registerClient(app), newPkce());
    const anonymous = await authorize(query);
    expect(anonymous.statusCode).toBe(302);
    expect(anonymous.headers.location).toBe(`/signin?next=${encodeURIComponent(`/oauth/authorize?${query}`)}&reason=signin`);
    const stale = await authorize(query, await signedInCookie(db, { verifiedAgoMs: 10 * 60_000 }));
    expect(stale.headers.location).toMatch(/&reason=fresh$/);
  });

  it('shows the app as unverified text, where the access goes and which resource', async () => {
    const id = await registerClient(app, { client_name: '<script>alert(1)</script>' });
    const res = await authorize(authorizeQuery(id, newPkce()), await signedInCookie(db));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    // no-referrer would make browsers send `Origin: null` with the decision, and sameOrigin() would refuse it.
    expect(res.headers['referrer-policy']).toBe('strict-origin');
    expect(res.body).toContain('<meta name="referrer" content="strict-origin">');
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.body).not.toContain('<script>alert');
    expect(res.body).toContain('it is not verified');
    expect(res.body).toContain('claude.ai');
    expect(res.body).toContain('MCP (all Tabula tools)');
    expect(res.body).toContain('value="claude-ai"');
    const api = await authorize(authorizeQuery(id, newPkce(), { resource: `${TEST_PUBLIC_URL}/api`, scope: 'api' }), await signedInCookie(db));
    expect(api.body).toContain('REST API (tabula CLI)');
  });
});

describe('POST /oauth/authorize', () => {
  const openPage = async (cookie: string, overrides: Record<string, string | undefined> = {}) => {
    const page = await authorize(authorizeQuery(await registerClient(app), newPkce(), overrides), cookie);
    return pendingOf(page.body);
  };

  it('Allow creates the named connection and redirects with the code, state and issuer, once', async () => {
    const cookie = await signedInCookie(db);
    const pending = await openPage(cookie);
    const res = await decide(app, cookie, pending, { name: 'claude-ai' });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get('state')).toBe('state-1');
    expect(location.searchParams.get('iss')).toBe(TEST_PUBLIC_URL);
    const [conn] = await db.select().from(oauthConnections);
    expect(conn).toMatchObject({ name: 'claude-ai', resource: 'mcp', scope: 'mcp offline_access', redirectUri: CALLBACK, revokedAt: null });
    expect((await decide(app, cookie, pending, { name: 'claude-ai' })).body).toContain('Request expired');
  });

  it('Deny redirects with access_denied and creates nothing', async () => {
    const cookie = await signedInCookie(db);
    const res = await decide(app, cookie, await openPage(cookie), { decision: 'deny' });
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('iss')).toBe(TEST_PUBLIC_URL);
    expect(await db.select().from(oauthConnections)).toHaveLength(0);
  });

  it('refuses a decision from another site, without a session, with a bad decision or a malformed request id', async () => {
    const cookie = await signedInCookie(db);
    const pending = await openPage(cookie);
    const form = (headers: Record<string, string>, body: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/oauth/authorize', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, payload: new URLSearchParams(body).toString() });
    expect((await form({ cookie }, { pending, decision: 'allow', name: 'x' })).statusCode).toBe(403);
    expect((await form({ cookie, origin: 'https://evil.example' }, { pending, decision: 'allow', name: 'x' })).statusCode).toBe(403);
    expect((await form({ cookie, origin: 'null' }, { pending, decision: 'allow', name: 'x' })).statusCode).toBe(403);
    expect((await form({ origin: TEST_PUBLIC_URL }, { pending, decision: 'allow', name: 'x' })).statusCode).toBe(401);
    expect((await decide(app, cookie, pending, { decision: 'maybe' })).statusCode).toBe(400);
    expect((await decide(app, cookie, 'not-a-uuid', { name: 'x' })).statusCode).toBe(400);
    expect(await db.select().from(oauthPending)).toHaveLength(1);
  });

  it('asks for a fresh passkey check before Allow, and keeps the request for it', async () => {
    const cookie = await signedInCookie(db);
    const pending = await openPage(cookie);
    const stale = await signedInCookie(db, { verifiedAgoMs: 10 * 60_000 });
    const res = await decide(app, stale, pending, { name: 'late' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Confirm with passkey');
    expect(res.body).toContain('href="/signin?next=%2Foauth%2Fauthorize%3F');
    expect((await decide(app, cookie, pending, { name: 'late' })).statusCode).toBe(302);
  });

  it('refuses an invalid name and keeps the request', async () => {
    const cookie = await signedInCookie(db);
    const pending = await openPage(cookie);
    for (const name of ['human', 'Bad Name', '']) {
      const res = await decide(app, cookie, pending, { name });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('role="alert"');
    }
    expect((await decide(app, cookie, pending, { name: 'good' })).statusCode).toBe(302);
  });

  it('replaces a live connection of the same name only when asked to', async () => {
    await obtainCode(app, db, { name: 'claude-code' });
    const [old] = await db.select().from(oauthConnections).where(eq(oauthConnections.name, 'claude-code'));
    const oldToken = await issueTokenPair(db, old!, new Date());

    // Claude Code registers anew (a new client) while the connection it made before is live.
    const cookie = await signedInCookie(db);
    const again = await registerClient(app, { client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1/callback'] });
    const page = await authorize(authorizeQuery(again, newPkce(), { redirect_uri: 'http://127.0.0.1:50000/callback' }), cookie);
    expect(page.body).toContain('value="claude-code" required');
    expect(page.body).toContain('name="replace" value="claude-code" checked');
    const pending = pendingOf(page.body);

    const refused = await decide(app, cookie, pending, { name: 'claude-code' });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('exists already');
    expect(refused.body).toContain('Tick Replace');
    // The owner's unticked box stays unticked.
    expect(refused.body).toContain('name="replace" value="claude-code">');
    expect(refused.body).not.toContain(' checked');
    expect((await authenticateAccessToken(db, oldToken.accessToken, 'mcp', new Date())).ok).toBe(true);

    const replaced = await decide(app, cookie, pending, { name: 'claude-code', replace: 'claude-code' });
    expect(replaced.statusCode).toBe(302);
    expect((await authenticateAccessToken(db, oldToken.accessToken, 'mcp', new Date())).ok).toBe(false);
    const live = (await db.select().from(oauthConnections).where(eq(oauthConnections.name, 'claude-code'))).filter((c) => c.revokedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ clientId: again, redirectUri: 'http://127.0.0.1:50000/callback' });
    const newToken = await issueTokenPair(db, live[0]!, new Date());
    expect(await authenticateAccessToken(db, newToken.accessToken, 'mcp', new Date())).toMatchObject({ ok: true, connectionId: live[0]!.id, name: 'claude-code' });
    expect((await authenticateAccessToken(db, oldToken.accessToken, 'mcp', new Date())).ok).toBe(false);
  });

  it('replaces only the connection the ticked box named', async () => {
    await obtainCode(app, db, { name: 'claude-code' });
    await obtainCode(app, db, { name: 'claude-ai' });
    const cookie = await signedInCookie(db);
    const again = await registerClient(app, { client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1/callback'] });
    const page = await authorize(authorizeQuery(again, newPkce(), { redirect_uri: 'http://127.0.0.1:50000/callback' }), cookie);
    expect(page.body).toContain('name="replace" value="claude-code" checked');

    // The owner types another taken name; the ticked box still names claude-code.
    const res = await decide(app, cookie, pendingOf(page.body), { name: 'claude-ai', replace: 'claude-code' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('A connection named &quot;claude-ai&quot; exists already');
    expect(res.body).toContain('name="replace" value="claude-ai">');
    expect(res.body).not.toContain(' checked');
    const live = await db.select().from(oauthConnections).where(isNull(oauthConnections.revokedAt));
    expect(live.map((c) => c.name).sort()).toEqual(['claude-ai', 'claude-code']);
  });
});

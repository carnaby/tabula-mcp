import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { createSession } from '../src/auth/sessions.js';
import type { Db } from '../src/db/client.js';
import { TEST_PUBLIC_URL } from './helpers.js';

/** The OAuth client side for the tests, over app.inject: every code comes from /oauth/authorize itself. */

export const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
export type Pkce = { verifier: string; challenge: string };

export function newPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** A signed-in browser: the cookie of a session whose last passkey check was `verifiedAgoMs` ago. */
export async function signedInCookie(db: Db, opts: { verifiedAgoMs?: number } = {}): Promise<string> {
  const { token } = await createSession(db, { userAgent: 'test', now: new Date(Date.now() - (opts.verifiedAgoMs ?? 0)) });
  return `tabula_session=${token}`;
}

let address = 0;
export async function registerClient(app: FastifyInstance, meta: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/oauth/register', headers: { 'x-forwarded-for': `192.0.2.${++address % 250}` },
    payload: { client_name: 'Claude', redirect_uris: [CALLBACK], ...meta },
  });
  expect(res.statusCode).toBe(201);
  return res.json().client_id as string;
}

export function authorizeQuery(clientId: string, pkce: Pkce, overrides: Record<string, string | undefined> = {}): string {
  const params: Record<string, string | undefined> = {
    response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: pkce.challenge, code_challenge_method: 'S256',
    state: 'state-1', scope: 'mcp offline_access', resource: `${TEST_PUBLIC_URL}/mcp`, ...overrides,
  };
  return new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();
}

export const pendingOf = (html: string): string => /name="pending" value="([^"]+)"/.exec(html)?.[1] ?? '';

/** POST of the consent form from Tabula's own page; Allow unless `fields.decision` says otherwise. */
export function decide(app: FastifyInstance, cookie: string, pending: string, fields: Record<string, string> = {}) {
  return app.inject({
    method: 'POST', url: '/oauth/authorize',
    headers: { cookie, origin: TEST_PUBLIC_URL, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ pending, decision: 'allow', ...fields }).toString(),
  });
}

/** Register (unless clientId is given), sign in, open the consent page and Allow: the code from the redirect. */
export async function obtainCode(
  app: FastifyInstance, db: Db,
  opts: { clientId?: string; pkce?: Pkce; query?: Record<string, string | undefined>; name?: string } = {},
) {
  const clientId = opts.clientId ?? (await registerClient(app));
  const pkce = opts.pkce ?? newPkce();
  const cookie = await signedInCookie(db);
  const page = await app.inject({ method: 'GET', url: `/oauth/authorize?${authorizeQuery(clientId, pkce, opts.query)}`, headers: { cookie } });
  expect(page.statusCode).toBe(200);
  const res = await decide(app, cookie, pendingOf(page.body), { name: opts.name ?? `app-${randomBytes(4).toString('hex')}`, replace: 'on' });
  expect(res.statusCode).toBe(302);
  const location = new URL(res.headers.location as string);
  return { code: location.searchParams.get('code')!, pkce, clientId, redirectUri: opts.query?.redirect_uri ?? CALLBACK, location };
}

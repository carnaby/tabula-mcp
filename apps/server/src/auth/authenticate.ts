import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { bearerToken } from '../http/auth.js';
import { readCookie, sessionCookie } from './cookie.js';
import { authenticateAccessToken } from './oauth/store.js';
import { authenticateSession, SESSION_TTL_MS, type UiSession } from './sessions.js';
import { type AuthSettings, RESOURCE_PATHS, type ResourceKind } from './settings.js';

/** Who a request authenticated as. */
export type Principal =
  | { kind: 'session'; session: UiSession }
  | { kind: 'oauth'; connectionId: string; name: string };

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by apiAuth / mcpAuth / appAuth; null on routes that do not authenticate. */
    principal: Principal | null;
  }
}

export type AuthContext = { db: Db; config: Config; auth: AuthSettings };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The 401 challenge (RFC 6750, RFC 9728): where the authorization server is described and which scope this resource
 * needs; `invalid_token` when a token was sent and refused.
 */
export function challenge(auth: AuthSettings, kind: ResourceKind, invalidToken: boolean): string {
  const params = [`resource_metadata="${auth.issuer}/.well-known/oauth-protected-resource/${RESOURCE_PATHS[kind]}"`, `scope="${kind}"`];
  if (invalidToken) params.push('error="invalid_token"');
  return `Bearer ${params.join(', ')}`;
}

/** A browser request that changes something with the session cookie must come from Tabula's own pages (spec §4.3). */
export const sameOrigin = (req: FastifyRequest, auth: AuthSettings): boolean => req.headers.origin === auth.issuer;

/**
 * The live session of the request's cookie, if any. A use that renewed the session (its 30 days start again) sends the
 * cookie again, so the browser keeps it as long as the server does, on every route that reads it.
 */
export async function sessionFromCookie(ctx: Pick<AuthContext, 'db' | 'auth'>, req: FastifyRequest, reply: FastifyReply, now: Date) {
  const value = readCookie(req.headers.cookie, ctx.auth.cookie.name);
  const found = value ? await authenticateSession(ctx.db, value, now) : undefined;
  if (found?.renewed) reply.header('Set-Cookie', sessionCookie(ctx.auth, value!, SESSION_TTL_MS));
  return found;
}

async function fromBearer(ctx: AuthContext, token: string, kind: ResourceKind): Promise<Principal | null> {
  const r = await authenticateAccessToken(ctx.db, token, kind, new Date());
  return r.ok ? { kind: 'oauth', connectionId: r.connectionId, name: r.name } : null;
}

const unauthorized = (reply: FastifyReply, ctx: AuthContext, kind: ResourceKind, invalidToken: boolean) =>
  reply.code(401).header('WWW-Authenticate', challenge(ctx.auth, kind, invalidToken)).send({ error: 'unauthorized' });

/** /api: an OAuth token for /api (the CLI) or the session cookie (the web UI). */
export function apiAuth(ctx: AuthContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const bearer = bearerToken(req);
    if (bearer !== undefined) {
      const p = await fromBearer(ctx, bearer, 'api');
      if (!p) return unauthorized(reply, ctx, 'api', true);
      req.principal = p;
      return;
    }
    const found = await sessionFromCookie(ctx, req, reply, new Date());
    if (found) {
      if (!SAFE_METHODS.has(req.method) && !sameOrigin(req, ctx.auth)) {
        return reply.code(403).send({ error: 'forbidden', message: 'cross-origin request refused' });
      }
      req.principal = { kind: 'session', session: found.session };
      return;
    }
    return unauthorized(reply, ctx, 'api', false);
  };
}

/** /mcp: an OAuth token for /mcp. Never the session cookie. */
export function mcpAuth(ctx: AuthContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const bearer = bearerToken(req);
    const p = bearer === undefined ? null : await fromBearer(ctx, bearer, 'mcp');
    if (!p) return unauthorized(reply, ctx, 'mcp', bearer !== undefined);
    req.principal = p;
  };
}

/**
 * /app-api: an OAuth token issued for /app-api and nothing else — no session cookie, no token of another resource, no
 * Inbox token (App API spec §2). Answers in the App API's error shape.
 */
export function appAuth(ctx: AuthContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const bearer = bearerToken(req);
    const p = bearer === undefined ? null : await fromBearer(ctx, bearer, 'app');
    if (!p) {
      return reply
        .code(401)
        .header('WWW-Authenticate', challenge(ctx.auth, 'app', bearer !== undefined))
        .send({ error: 'unauthorized', message: "send an OAuth access token issued for this server's /app-api" });
    }
    req.principal = p;
  };
}

/** Security settings and sign-out belong to the person's web session, never to an app. */
export async function requirePerson(req: FastifyRequest, reply: FastifyReply) {
  if (req.principal?.kind !== 'session') {
    return reply.code(403).send({ error: 'forbidden', message: 'only the web UI can do this; an app connection cannot' });
  }
}

/**
 * Who writes over /api, from how the request authenticated: an app by its connection name, the web UI as the human.
 * /api never carries a model.
 */
export function apiEditor(req: FastifyRequest): { source: 'agent' | 'human'; label: string } {
  const p = req.principal;
  return p?.kind === 'oauth' ? { source: 'agent', label: p.name } : { source: 'human', label: 'human' };
}

export const apiWriterLabel = (req: FastifyRequest): string => apiEditor(req).label;

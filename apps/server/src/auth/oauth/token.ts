import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db/client.js';
import { type FormBody, formOf, useFormBody } from '../form.js';
import type { AuthSettings } from '../settings.js';
import { perAddressLimit, sendOAuthError } from './errors.js';
import { exchangeCode, refreshTokens, type TokenError, type TokenOutcome } from './tokens.js';

export const FORM_BODY_LIMIT = 8 * 1024;
export const INVALID_FORM = 'send the parameters, each once, as application/x-www-form-urlencoded';

/** Fixed texts: never anything the caller sent, never which check failed. */
const DESCRIPTIONS: Record<TokenError, string> = {
  invalid_grant: 'the code or refresh token is invalid, expired or revoked, or was issued to another client; authorize again',
  invalid_client: 'unknown client_id; register the client again',
  invalid_scope: 'scope may only narrow the scope already granted',
  invalid_target: "resource must be this server's /mcp or /api, the one the grant was made for",
};

/** A body Fastify could not read (too large, another media type) is answered in RFC 6749's shape. */
export async function unreadableForm(error: FastifyError, _req: FastifyRequest, reply: FastifyReply) {
  if ((error.statusCode ?? 500) >= 500) throw error;
  return sendOAuthError(reply, 400, 'invalid_request', INVALID_FORM);
}

/** Every listed parameter, present and non-empty, or undefined. */
function required<K extends string>(form: FormBody, names: readonly K[]): Record<K, string> | undefined {
  const out = {} as Record<K, string>;
  for (const name of names) {
    const value = form.get(name);
    if (value === undefined || value === '') return undefined;
    out[name] = value;
  }
  return out;
}

const optional = <K extends string>(form: FormBody, name: K): Partial<Record<K, string>> => {
  const value = form.get(name);
  return value === undefined ? {} : ({ [name]: value } as Record<K, string>);
};

export async function registerToken(app: FastifyInstance, deps: { db: Db; auth: AuthSettings }): Promise<void> {
  const limit = perAddressLimit(30, 60_000, 'too many token requests from this address; try again in a minute');
  const answer = (reply: FastifyReply, outcome: TokenOutcome) => {
    if (!outcome.ok) return sendOAuthError(reply, outcome.error === 'invalid_client' ? 401 : 400, outcome.error, DESCRIPTIONS[outcome.error]);
    const t = outcome.tokens;
    return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send({
      access_token: t.accessToken, token_type: 'Bearer', expires_in: t.expiresIn, refresh_token: t.refreshToken, scope: t.scope,
    });
  };

  await app.register(async (forms) => {
    useFormBody(forms);
    forms.post('/oauth/token', { bodyLimit: FORM_BODY_LIMIT, onRequest: limit, errorHandler: unreadableForm }, async (req, reply) => {
      const form = formOf(req);
      if (!form || form.repeated) return sendOAuthError(reply, 400, 'invalid_request', INVALID_FORM);
      const grantType = form.get('grant_type');
      const now = new Date();
      if (grantType === 'authorization_code') {
        const p = required(form, ['code', 'redirect_uri', 'client_id', 'code_verifier'] as const);
        if (!p) return sendOAuthError(reply, 400, 'invalid_request', INVALID_FORM);
        return answer(reply, await exchangeCode(deps.db, deps.auth, {
          code: p.code, clientId: p.client_id, redirectUri: p.redirect_uri, codeVerifier: p.code_verifier, ...optional(form, 'resource'),
        }, now));
      }
      if (grantType === 'refresh_token') {
        const p = required(form, ['refresh_token', 'client_id'] as const);
        if (!p) return sendOAuthError(reply, 400, 'invalid_request', INVALID_FORM);
        return answer(reply, await refreshTokens(deps.db, deps.auth, {
          refreshToken: p.refresh_token, clientId: p.client_id, ...optional(form, 'resource'), ...optional(form, 'scope'),
        }, now));
      }
      if (!grantType) return sendOAuthError(reply, 400, 'invalid_request', INVALID_FORM);
      return sendOAuthError(reply, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    });
  });
}

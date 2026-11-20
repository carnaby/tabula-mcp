import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db/client.js';
import { isDisplayableClientName } from '../names.js';
import { isAllowedRedirect } from './crypto.js';
import { perAddressLimit, sendOAuthError } from './errors.js';
import { countClientsWithoutConnection, createClient, MAX_UNAPPROVED_CLIENTS } from './store.js';

/*
 * Dynamic client registration (RFC 7591). Open to anyone: the protection is the owner's consent, where the client's
 * name and the host of its redirect are shown. What this guards against is cost: 10 registrations an hour per address
 * and at most 1000 clients nobody approved (the sweeper deletes those after 24 h).
 */

const REGISTER_BODY_LIMIT = 16 * 1024;
const MAX_REDIRECT_URIS = 5;
const MAX_CLIENT_NAME_CHARACTERS = 100;
const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

export type Registration = { clientName: string | null; redirectUris: string[]; grantTypes: string[] };
type Refusal = { error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };

const NOT_JSON: Refusal = { error: 'invalid_client_metadata', description: 'send the client metadata as a JSON object' };
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** What the request asks for, or why it is refused. Only these fields are read; others are ignored and never echoed. */
export function parseRegistration(body: unknown): Registration | Refusal {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return NOT_JSON;
  const fields = body as Record<string, unknown>;

  const redirectUris = fields.redirect_uris;
  if (!isStringArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS || !redirectUris.every(isAllowedRedirect)) {
    return {
      error: 'invalid_redirect_uri',
      description: `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs, each https:// with a host or http:// on localhost, 127.0.0.1 or [::1], without a fragment, at most 512 characters`,
    };
  }
  const method = fields.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') {
    return { error: 'invalid_client_metadata', description: 'only public clients are supported: token_endpoint_auth_method must be "none"' };
  }
  const grantTypes = fields.grant_types;
  if (
    grantTypes !== undefined &&
    (!isStringArray(grantTypes) || !grantTypes.includes('authorization_code') || !grantTypes.every((g) => (GRANT_TYPES as readonly string[]).includes(g)))
  ) {
    return { error: 'invalid_client_metadata', description: 'grant_types must include authorization_code and may add refresh_token, nothing else' };
  }
  const responseTypes = fields.response_types;
  if (responseTypes !== undefined && (!isStringArray(responseTypes) || responseTypes.length === 0 || !responseTypes.every((r) => r === 'code'))) {
    return { error: 'invalid_client_metadata', description: 'response_types must be ["code"]' };
  }
  const name = fields.client_name;
  if (name !== undefined && (typeof name !== 'string' || [...name].length > MAX_CLIENT_NAME_CHARACTERS || !isDisplayableClientName(name))) {
    return {
      error: 'invalid_client_metadata',
      description: `client_name must be text of at most ${MAX_CLIENT_NAME_CHARACTERS} characters, without control, format or invisible characters`,
    };
  }
  return {
    clientName: typeof name === 'string' && name.length > 0 ? name : null,
    redirectUris: [...redirectUris],
    grantTypes: grantTypes === undefined ? [...GRANT_TYPES] : GRANT_TYPES.filter((g) => grantTypes.includes(g)),
  };
}

export function registerClientRegistration(app: FastifyInstance, db: Db): void {
  const limit = perAddressLimit(10, 3600_000, 'too many client registrations from this address; try again later');

  /** A body Fastify could not read is still answered in RFC 7591's shape. */
  const unreadable = async (error: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) throw error;
    return sendOAuthError(reply, status === 413 ? 413 : 400, NOT_JSON.error, NOT_JSON.description);
  };

  app.post('/oauth/register', { bodyLimit: REGISTER_BODY_LIMIT, onRequest: limit, errorHandler: unreadable }, async (req, reply) => {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return sendOAuthError(reply, 400, NOT_JSON.error, NOT_JSON.description);
    const parsed = parseRegistration(req.body);
    if ('error' in parsed) return sendOAuthError(reply, 400, parsed.error, parsed.description);
    if ((await countClientsWithoutConnection(db)) >= MAX_UNAPPROVED_CLIENTS) {
      return sendOAuthError(reply, 503, 'temporarily_unavailable', 'this server is not accepting new client registrations right now; try again later');
    }
    const client = await createClient(db, { clientName: parsed.clientName, redirectUris: parsed.redirectUris });
    return reply
      .code(201)
      .header('cache-control', 'no-store')
      .send({
        client_id: client.id,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        ...(client.clientName === null ? {} : { client_name: client.clientName }),
        redirect_uris: client.redirectUris,
        grant_types: parsed.grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
  });
}

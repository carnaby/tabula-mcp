import type { FastifyInstance } from 'fastify';
import { type AuthSettings, RESOURCE_KINDS, type ResourceKind } from '../settings.js';

/*
 * The discovery documents (spec §3.1, Limen §2 points 2–3). Every value comes from TABULA_PUBLIC_URL, never from Host
 * or X-Forwarded-*: what a client pins is what the owner configured.
 */

const CACHE = 'public, max-age=300';
/** A refresh token is asked for with this scope; offered by the authorization server, never by a resource. */
export const OFFLINE_ACCESS = 'offline_access';

export function protectedResourceMetadata(auth: AuthSettings, kind: ResourceKind) {
  return { resource: auth.resources[kind], authorization_servers: [auth.issuer], scopes_supported: [kind], bearer_methods_supported: ['header'] };
}

export function authorizationServerMetadata(auth: AuthSettings) {
  const { issuer } = auth;
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...RESOURCE_KINDS, OFFLINE_ACCESS],
    authorization_response_iss_parameter_supported: true,
  };
}

export function registerMetadata(app: FastifyInstance, auth: AuthSettings): void {
  const serve = (path: string, doc: object) => app.get(path, (_req, reply) => reply.header('cache-control', CACHE).send(doc));
  for (const kind of RESOURCE_KINDS) serve(`/.well-known/oauth-protected-resource/${kind}`, protectedResourceMetadata(auth, kind));
  // RFC 9728 §3: also without the resource's path, for clients that look there first; /mcp is the main resource.
  serve('/.well-known/oauth-protected-resource', protectedResourceMetadata(auth, 'mcp'));
  serve('/.well-known/oauth-authorization-server', authorizationServerMetadata(auth));
}

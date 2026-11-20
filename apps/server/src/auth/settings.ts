import type { Config } from '../config.js';

/** The two protected resources: /mcp for MCP clients, /api for the tabula CLI. A token is bound to one of them. */
export type ResourceKind = 'mcp' | 'api';
export const RESOURCE_KINDS = ['mcp', 'api'] as const;

export type AuthSettings = {
  /** RFC 8414 issuer and the WebAuthn origin: TABULA_PUBLIC_URL, never derived from a request's Host header. */
  issuer: string;
  resources: Record<ResourceKind, string>;
  /** The passkey domain (RP ID): the host of the public URL. */
  rpId: string;
  cookie: { name: string; secure: boolean };
};

export function authSettings(config: Pick<Config, 'publicUrl'>): AuthSettings | null {
  if (!config.publicUrl) return null;
  const url = new URL(config.publicUrl);
  const secure = url.protocol === 'https:';
  return {
    issuer: config.publicUrl,
    resources: { mcp: `${config.publicUrl}/mcp`, api: `${config.publicUrl}/api` },
    rpId: url.hostname,
    // A __Host- cookie must be Secure; plain http is allowed only on localhost (development and tests).
    cookie: { name: secure ? '__Host-tabula_session' : 'tabula_session', secure },
  };
}

/** Which resource an RFC 8707 `resource` value names, or null for anything else. */
export function resourceKindOf(auth: AuthSettings, resource: string): ResourceKind | null {
  if (resource === auth.resources.mcp) return 'mcp';
  if (resource === auth.resources.api) return 'api';
  return null;
}

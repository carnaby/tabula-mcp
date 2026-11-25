import type { Config } from '../config.js';

/**
 * The protected resources: /mcp for MCP clients, /api for the tabula CLI, /app-api for apps that write on the owner's
 * behalf. A token is bound to one of them.
 */
export type ResourceKind = 'mcp' | 'api' | 'app';
export const RESOURCE_KINDS = ['mcp', 'api', 'app'] as const;
/** The path of each resource under TABULA_PUBLIC_URL; RFC 9728 puts its metadata at /.well-known/oauth-protected-resource/<path>. */
export const RESOURCE_PATHS: Record<ResourceKind, string> = { mcp: 'mcp', api: 'api', app: 'app-api' };
/** Read the headers of every project's Inbox messages over the App API, never their text (inbox-read spec §2). */
export const INBOX_READ = 'inbox:read';
/** What a resource grants on top of its own scope when asked: only the App API offers more. */
export const RESOURCE_SCOPES: Record<ResourceKind, readonly string[]> = { mcp: [], api: [], app: [INBOX_READ] };

export type AuthSettings = {
  /** RFC 8414 issuer and the WebAuthn origin: TABULA_PUBLIC_URL, never derived from a request's Host header. */
  issuer: string;
  resources: Record<ResourceKind, string>;
  /** The passkey domain (RP ID): the host of the public URL. */
  rpId: string;
  cookie: { name: string; secure: boolean };
};

export function authSettings(config: Pick<Config, 'publicUrl'>): AuthSettings {
  const url = new URL(config.publicUrl);
  const secure = url.protocol === 'https:';
  return {
    issuer: config.publicUrl,
    resources: {
      mcp: `${config.publicUrl}/${RESOURCE_PATHS.mcp}`,
      api: `${config.publicUrl}/${RESOURCE_PATHS.api}`,
      app: `${config.publicUrl}/${RESOURCE_PATHS.app}`,
    },
    rpId: url.hostname,
    // A __Host- cookie must be Secure; plain http is allowed only on localhost (development and tests).
    cookie: { name: secure ? '__Host-tabula_session' : 'tabula_session', secure },
  };
}

/** Which resource an RFC 8707 `resource` value names, or null for anything else. */
export function resourceKindOf(auth: AuthSettings, resource: string): ResourceKind | null {
  return RESOURCE_KINDS.find((kind) => auth.resources[kind] === resource) ?? null;
}

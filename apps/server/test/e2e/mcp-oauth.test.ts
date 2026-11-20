import { auth, Client, type OAuthClientProvider, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { getThought } from '../../src/domain/thoughts.js';
import { useTestDb } from '../helpers.js';
import { pendingOf, signedInCookie, useAuthServer } from '../oauth-flow.js';

/**
 * The whole connection the way an MCP client makes it: the SDK's own OAuth client (auth(), the code Claude Code runs)
 * against a real server. The one step the SDK cannot do is the browser: the test opens the consent page itself.
 */

const db = useTestDb();
const server = useAuthServer(db);

/** Claude Code's shape: a loopback redirect on a port of its own choosing. */
const REDIRECT = 'http://127.0.0.1:33418/callback';
type Tokens = Parameters<OAuthClientProvider['saveTokens']>[0];
type ClientInfo = Parameters<NonNullable<OAuthClientProvider['saveClientInformation']>>[0];
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

class MemoryProvider implements OAuthClientProvider {
  client: ClientInfo | undefined;
  saved: Tokens | undefined;
  verifier = '';
  authorizationUrl: URL | undefined;

  get redirectUrl() {
    return REDIRECT;
  }

  get clientMetadata(): OAuthClientProvider['clientMetadata'] {
    return {
      client_name: 'Tabula e2e',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation() {
    return this.client;
  }

  saveClientInformation(info: ClientInfo) {
    this.client = info;
  }

  tokens() {
    return this.saved;
  }

  saveTokens(tokens: Tokens) {
    this.saved = tokens;
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier() {
    return this.verifier;
  }
}

describe('the MCP SDK OAuth client, end to end', () => {
  it('discovery → registration → consent → token → tools → a write with model → refresh → revoke → 401', async () => {
    const mcpUrl = `${server.url}/mcp`;
    const provider = new MemoryProvider();

    expect(await auth(provider, { serverUrl: mcpUrl })).toBe('REDIRECT');
    const authorizationUrl = provider.authorizationUrl!;
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(`${server.url}/oauth/authorize`);
    expect(authorizationUrl.searchParams.get('resource')).toBe(mcpUrl);

    // The browser: not signed in, so to /signin first; then, signed in, the consent page.
    const first = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toMatch(/^\/signin\?next=/);
    const cookie = await signedInCookie(db);
    const page = await fetch(authorizationUrl, { redirect: 'manual', headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Tabula e2e');
    const decided = await fetch(`${server.url}/oauth/authorize`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pending: pendingOf(html), decision: 'allow', name: 'e2e-client' }),
    });
    expect(decided.status).toBe(302);
    const callback = new URL(decided.headers.get('location')!);
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
    expect(callback.searchParams.get('iss')).toBe(server.url);

    // The SDK exchanges the code (RFC 9207: it checks iss against the issuer it discovered).
    const code = callback.searchParams.get('code')!;
    expect(await auth(provider, { serverUrl: mcpUrl, authorizationCode: code, iss: callback.searchParams.get('iss')! })).toBe('AUTHORIZED');
    const issued = provider.saved!;
    expect(issued).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(issued.refresh_token).toBeDefined();

    // tools/list and a write over Streamable HTTP with the access token.
    const client = new Client({ name: 'tabula-oauth-e2e', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('save_thought');
    const result = await client.callTool({ name: 'save_thought', arguments: { title: 'From e2e', body: 'x', model: 'claude-opus-5-5' } });
    const saved = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { id: string };
    expect(await getThought(db, saved.id)).toMatchObject({ editedBy: 'e2e-client', editedByModel: 'claude-opus-5-5' });
    await client.close();

    // A refresh: auth() with a refresh token on hand rotates the pair.
    expect(await auth(provider, { serverUrl: mcpUrl })).toBe('AUTHORIZED');
    const refreshed = provider.saved!;
    expect(refreshed.access_token).not.toBe(issued.access_token);
    expect(refreshed.refresh_token).not.toBe(issued.refresh_token);

    // Revoking the refresh token ends the connection: the access token is refused.
    const revoked = await fetch(`${server.url}/oauth/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshed.refresh_token!, client_id: provider.client!.client_id }),
    });
    expect(revoked.status).toBe(200);
    const after = await fetch(mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${refreshed.access_token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify(init),
    });
    expect(after.status).toBe(401);
    expect(after.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
});

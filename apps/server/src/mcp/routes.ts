import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type AuthContext, mcpAuth } from '../auth/authenticate.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { FILE_LIMITS } from '../domain/files.js';
import { sanitizeAgentLabel } from '../domain/validation.js';
import { safeEqual } from '../http/auth.js';
import type { MediaStore } from '../media/store.js';
import { buildMcpServer } from './server.js';

/** The origin the client used (behind a TLS proxy: its forwarded headers), for absolute attachment links. */
function originOf(req: FastifyRequest): string {
  const first = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h)?.split(',')[0]?.trim();
  const proto = first(req.headers['x-forwarded-proto']) ?? req.protocol;
  const host = first(req.headers['x-forwarded-host']) ?? req.headers.host ?? 'localhost';
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

/**
 * write_file carries a file of up to 1 MiB inside a JSON-RPC body, where JSON escaping can make it several times
 * larger; the domain enforces the real 1 MiB limit (as the REST PUT does).
 */
const MCP_BODY_LIMIT = 8 * FILE_LIMITS.contentBytes;

const METHOD_NOT_ALLOWED = { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null };

export function registerMcpRoutes(
  app: FastifyInstance, deps: { db: Db; config: Config; store: MediaStore; mediaKey: string; authCtx: AuthContext },
): void {
  // Stateless: a new server + transport per request; agentLabel is captured in the closure.
  const handle = async (req: FastifyRequest, reply: FastifyReply, agentLabel: string) => {
    const server = buildMcpServer({
      db: deps.db, agentLabel, log: req.log,
      transcriptionEnabled: deps.config.fornax !== undefined,
      media: { store: deps.store, key: deps.mediaKey, paths: deps.config.media, baseUrl: originOf(req) },
    });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };

  // Authentication runs before the body is read: only an authorized client gets the larger body limit.
  // An OAuth connection writes under its own name; the old token keeps the X-Tabula-Agent header (spec §5).
  app.post('/mcp', { bodyLimit: MCP_BODY_LIMIT, onRequest: mcpAuth(deps.authCtx) }, (req, reply) =>
    handle(req, reply, req.principal?.kind === 'oauth' ? req.principal.name : sanitizeAgentLabel(req.headers['x-tabula-agent'])),
  );

  const secret = deps.config.connectorSecret;
  if (secret) {
    app.post<{ Params: { secret: string } }>(
      '/mcp/:secret',
      {
        bodyLimit: MCP_BODY_LIMIT,
        onRequest: async (req, reply) => {
          if (!safeEqual(req.params.secret, secret)) return reply.code(404).send({ error: 'not found' });
          await deps.authCtx.legacy.record('connector');
        },
      },
      async (req, reply) => {
        const header = req.headers['x-tabula-agent'];
        return handle(req, reply, header ? sanitizeAgentLabel(header) : 'claude-ai');
      },
    );
    // After initialize the client tries GET (SSE stream); without this route the default 404 handler would log the URL containing the secret.
    app.route<{ Params: { secret: string } }>({
      method: ['GET', 'DELETE'],
      url: '/mcp/:secret',
      handler: (req, reply) =>
        safeEqual(req.params.secret, secret)
          ? reply.code(405).send(METHOD_NOT_ALLOWED)
          : reply.code(404).send({ error: 'not found' }),
    });
  }

  for (const method of ['GET', 'DELETE'] as const) {
    app.route({ method, url: '/mcp', handler: (_req, reply) => reply.code(405).send(METHOD_NOT_ALLOWED) });
  }
}

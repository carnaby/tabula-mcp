import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { DomainError } from '../domain/errors.js';
import { registerMcpRoutes } from '../mcp/routes.js';
import { apiRoutes } from './api.js';
import { registerCliRoutes } from './cli.js';

// The secret in the /mcp/<secret> path must never reach the logs.
const maskUrl = (url: string) => url.replace(/^\/mcp\/[^/?#]+/, '/mcp/***');

export async function buildApp(deps: {
  config: Config;
  db: Db;
  /** Tests only: where to write logs (default stdout). */
  logStream?: { write(msg: string): void };
}): Promise<FastifyInstance> {
  const secret = deps.config.connectorSecret;
  // Also masks the secret outside /mcp/<secret> (e.g. /MCP/<secret>) in case the URL ends up in the log by another route.
  const mask = (url: string) => {
    const masked = maskUrl(url);
    return secret ? masked.split(secret).join('***') : masked;
  };
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      serializers: {
        req: (req) => ({ method: req.method, url: mask(req.url), agent: req.headers['x-tabula-agent'] }),
      },
    },
  });

  // Fastify's default 404 handler logs "Route <METHOD>:<raw url> not found" (which would include the connector secret) and echoes the URL in the body.
  app.setNotFoundHandler((req, reply) => {
    req.log.info({ req }, 'route not found');
    return reply.code(404).send({ error: 'not found' });
  });

  app.setErrorHandler<FastifyError>((err, _req, reply) => {
    if (err instanceof DomainError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      app.log.error(err);
      return reply.code(status).send({ error: 'internal', message: 'internal error' });
    }
    return reply.code(status).send({ error: 'bad_request', message: err.message });
  });

  app.get('/healthz', async () => ({ ok: true }));
  registerCliRoutes(app);
  registerMcpRoutes(app, deps);
  await app.register(apiRoutes, { prefix: '/api', db: deps.db, config: deps.config });

  const webRoot = resolve(deps.config.webDist);
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, index: 'index.html' });
  } else {
    app.log.warn({ webRoot }, 'web build not found; UI is not served');
  }

  return app;
}

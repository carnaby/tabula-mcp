import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { AuthContext } from '../auth/authenticate.js';
import { LegacyUse, startLegacyTracking } from '../auth/legacy.js';
import { registerOAuth } from '../auth/oauth/routes.js';
import { registerAuthPages } from '../auth/pages-routes.js';
import { RegistrationLinks, registerPasskeyRoutes } from '../auth/passkeys/routes.js';
import { authSettings } from '../auth/settings.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { DomainError, isNulRefusal, loggableError, NUL_REFUSED } from '../domain/errors.js';
import { registerMcpRoutes } from '../mcp/routes.js';
import { apiRoutes } from './api.js';
import { registerCliRoutes } from './cli.js';
import { inboxApiRoutes } from './inbox-api.js';
import { mediaSigningKey } from '../media/key.js';
import { MediaStore } from '../media/store.js';
import { registerMediaRoute } from './reports-api.js';

// The secret in the /mcp/<secret> path, a passkey registration link, the signature of /media links (valid for hours)
// and an Inbox token put in a URL by mistake must never reach the logs. The registration link is masked anywhere in
// the URL and in any case, so a mistyped variant (/PASSKEY/register/…, //passkey/…, an absolute-form target) that
// ends in the not-found log is masked too.
const maskUrl = (url: string) =>
  url
    .replace(/^\/mcp\/[^/?#]+/, '/mcp/***')
    .replace(/\/+passkey\/register\/[^/?#]+/gi, '/passkey/register/***')
    .replace(/([?&]sig=)[^&#]*/g, '$1***')
    .replace(/tabula_inbox_[A-Za-z0-9_-]+/g, 'tabula_inbox_***');

export async function buildApp(deps: {
  config: Config;
  db: Db;
  /** Where report attachments live; built from config.media when omitted. */
  store?: MediaStore;
  /** Tests only: where to write logs (default stdout). */
  logStream?: { write(msg: string): void };
}): Promise<FastifyInstance> {
  const store = deps.store ?? new MediaStore(deps.config.media.dir, deps.config.media.maxBytes);
  const mediaKey = await mediaSigningKey(deps.db);
  const auth = authSettings(deps.config);
  await startLegacyTracking(deps.db);
  const authCtx: AuthContext = { db: deps.db, config: deps.config, auth, legacy: new LegacyUse(deps.db) };
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
  app.decorateRequest('principal', null);

  // Fastify's default 404 handler logs "Route <METHOD>:<raw url> not found" (which would include the connector secret) and echoes the URL in the body.
  app.setNotFoundHandler((req, reply) => {
    req.log.info({ req }, 'route not found');
    return reply.code(404).send({ error: 'not found' });
  });

  app.setErrorHandler<FastifyError>((err, _req, reply) => {
    if (err instanceof DomainError) {
      // The client gets a short message; what caused it (paths, ffmpeg output) goes to the log.
      if (err.cause) app.log[err.status >= 500 ? 'error' : 'warn']({ err: loggableError(err.cause) }, err.message);
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
    if (isNulRefusal(err)) {
      app.log.warn({ err: loggableError(err) }, NUL_REFUSED);
      return reply.code(400).send({ error: 'bad_request', message: NUL_REFUSED });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      // Never the query values (transcripts, file contents) that database errors carry.
      app.log.error(loggableError(err) as Error);
      return reply.code(status).send({ error: 'internal', message: 'internal error' });
    }
    return reply.code(status).send({ error: 'bad_request', message: err.message });
  });

  app.get('/healthz', async () => ({ ok: true }));
  registerCliRoutes(app);
  registerMcpRoutes(app, { ...deps, store, mediaKey, authCtx });
  registerMediaRoute(app, { db: deps.db, config: deps.config, store, mediaKey });
  if (auth) {
    // One budget of failed registration-link lookups per address, shared by every route that takes a link.
    const links = new RegistrationLinks(deps.db);
    registerPasskeyRoutes(app, { ...authCtx, auth, links });
    await registerAuthPages(app, { ...authCtx, auth, links });
    await registerOAuth(app, { ...authCtx, auth });
  }
  await app.register(apiRoutes, { prefix: '/api', db: deps.db, config: deps.config, store, mediaKey, authCtx });
  await app.register(inboxApiRoutes, { prefix: '/inbox-api/v1', db: deps.db });

  if (deps.config.webDist !== null) {
    const webRoot = resolve(deps.config.webDist);
    if (existsSync(webRoot)) await app.register(fastifyStatic, { root: webRoot, index: 'index.html' });
    else app.log.warn({ webRoot }, 'web build not found; UI is not served');
  }

  return app;
}

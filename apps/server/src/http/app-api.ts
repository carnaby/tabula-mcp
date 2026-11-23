import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { appAuth, type AuthContext, type Principal } from '../auth/authenticate.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { listProjects } from '../domain/projects.js';
import type { MediaStore } from '../media/store.js';
import { AppApiError, errorBody, logAppError, toAppError } from './app-api-errors.js';

export type AppApiDeps = { db: Db; config: Config; store: MediaStore; authCtx: AuthContext };

/** The connection a request authenticated as: appAuth admits only OAuth tokens issued for /app-api. */
export const connectionOf = (req: FastifyRequest) => req.principal as Extract<Principal, { kind: 'oauth' }>;

/**
 * The App API: a narrow, versioned REST API for apps that act on the owner's behalf. It is registered next to /api, so
 * it inherits neither that plugin's authentication nor its error shape. Routes live under /v1; the 404 handler covers
 * the whole /app-api prefix and, like every route here, runs after the authentication hook.
 */
export const appApiRoutes: FastifyPluginAsync<AppApiDeps> = async (app, deps) => {
  const { db } = deps;
  // onRequest, before the body is read: an upload from an unknown caller is never streamed.
  app.addHook('onRequest', appAuth(deps.authCtx));
  app.setErrorHandler((err, req, reply) => {
    const e = toAppError(err);
    logAppError(req, err, e);
    return reply.code(e.status).send(errorBody(e));
  });
  app.setNotFoundHandler((req, reply) => {
    req.log.info({ req }, 'route not found');
    return reply.code(404).send(errorBody(new AppApiError(404, 'not_found', 'no such endpoint in the App API')));
  });
  // When the web UI is served, its wildcard GET (and HEAD) route at the root would answer an unknown GET here before
  // the 404 handler, without authentication and in the root's shape; this more specific wildcard keeps it in the API.
  app.get('/*', async () => {
    throw new AppApiError(404, 'not_found', 'no such endpoint in the App API');
  });

  app.get('/v1/projects', async () => ({
    items: (await listProjects(db)).filter((p) => p.id !== 'global').map((p) => ({ slug: p.id, name: p.name, description: p.description })),
  }));
};

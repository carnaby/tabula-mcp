import { refOf } from '@tabula/shared/refs';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { appAuth, type AuthContext, type Principal } from '../auth/authenticate.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { DomainError } from '../domain/errors.js';
import { createMessage, findMessageByRef, MESSAGE_TYPES, type Message } from '../domain/messages.js';
import { createNote } from '../domain/notes.js';
import { listProjects, requireProject } from '../domain/projects.js';
import { createReport } from '../domain/reports.js';
import { createThought } from '../domain/thoughts.js';
import { normalizeModel } from '../domain/validation.js';
import type { MediaStore } from '../media/store.js';
import { AppApiError, errorBody, logAppError, parseBody, toAppError, translate, validationFailed } from './app-api-errors.js';
import { receiveAttachment } from './attachment-upload.js';

export type AppApiDeps = { db: Db; config: Config; store: MediaStore; authCtx: AuthContext };

/** The connection a request authenticated as: appAuth admits only OAuth tokens issued for /app-api. */
export const connectionOf = (req: FastifyRequest) => req.principal as Extract<Principal, { kind: 'oauth' }>;

/** What a POST answers: always 201 with the new record's identifiers (spec §3). */
export type Created = { status: 201; body: Record<string, unknown> };

/** The owner writes through the app (spec §4): source human, signed with the connection's name; a model only when given. */
export const editorOf = (req: FastifyRequest, model?: string) => ({
  source: 'human' as const,
  label: connectionOf(req).name,
  model: model === undefined ? null : normalizeModel(model),
});

/** A project an app may write to: an existing one, never "global". The API creates no projects. */
export async function requireAppProject(db: Db, slug: string, field: 'to' | 'project'): Promise<string> {
  if (slug === 'global') throw validationFailed([{ path: field, message: 'must be a project, not "global"' }]);
  try {
    await requireProject(db, slug);
  } catch (e) {
    if (e instanceof DomainError && e.code === 'not_found') {
      throw new AppApiError(404, 'project_not_found', `project "${slug}" does not exist; GET /app-api/v1/projects lists the projects`);
    }
    throw e;
  }
  return slug;
}

/**
 * A follow-up points at a message of the project it goes to: one sent to it or by it (spec §3). The Inbox domain has no
 * such rule, so the App API checks it; createMessage then resolves the id once more, which is harmless.
 */
async function relatedMessage(db: Db, raw: string, to: string): Promise<string> {
  let m: Message | undefined;
  try {
    m = await findMessageByRef(db, raw);
  } catch (e) {
    // Not a reference at all, or a prefix that matches several messages.
    if (e instanceof DomainError && e.code === 'bad_request') throw validationFailed([{ path: 'related_to', message: e.message }]);
    throw e;
  }
  if (!m || (m.toProject !== to && m.fromProject !== to)) {
    throw validationFailed([{ path: 'related_to', message: `must be a message sent to or by project "${to}"` }]);
  }
  return m.id;
}

const messageBody = z.strictObject({
  to: z.string(),
  type: z.enum(MESSAGE_TYPES),
  title: z.string(),
  body: z.string(),
  related_to: z.string().optional(),
});

const tags = z.array(z.string()).optional();
const thoughtBody = z.strictObject({ title: z.string(), body: z.string(), tags, model: z.string().optional() });
const noteBody = z.strictObject({ title: z.string(), body: z.string(), tags, project: z.string().optional() });
const reportBody = z.strictObject({ title: z.string().optional(), body: z.string().optional(), project: z.string().optional(), model: z.string().optional() });
/** The identifiers every new record is answered with. */
const ids = (id: string): Created => ({ status: 201, body: { id, ref: refOf(id) } });
const reportParams = z.object({ id: z.uuid() });

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
  // Bodies are JSON (an upload has its own parser): any other type is refused with 415.
  app.removeContentTypeParser('text/plain');

  /** A POST that creates something; `run` says what to answer. */
  const created = (instance: FastifyInstance, path: string, run: (req: FastifyRequest, reply: FastifyReply) => Promise<Created>) =>
    instance.post(path, async (req, reply) => {
      const r = await run(req, reply);
      return reply.code(r.status).send(r.body);
    });

  // When the web UI is served, its wildcard GET (and HEAD) route at the root would answer an unknown GET here before
  // the 404 handler, without authentication and in the root's shape; this more specific wildcard keeps it in the API.
  app.get('/*', async () => {
    throw new AppApiError(404, 'not_found', 'no such endpoint in the App API');
  });

  app.get('/v1/projects', async () => ({
    items: (await listProjects(db)).filter((p) => p.id !== 'global').map((p) => ({ slug: p.id, name: p.name, description: p.description })),
  }));

  created(app, '/v1/messages', async (req) => {
    const b = parseBody(messageBody, req.body);
    const to = await requireAppProject(db, b.to, 'to');
    const relatedTo = b.related_to === undefined ? undefined : await relatedMessage(db, b.related_to, to);
    const m = await createMessage(db, { to, from: null, type: b.type, title: b.title, body: b.body, relatedTo }, editorOf(req));
    return { status: 201, body: { id: m.id, ref: refOf(m.id), status: m.status, version: m.version } };
  });
  created(app, '/v1/thoughts', async (req) => {
    const b = parseBody(thoughtBody, req.body);
    return ids((await createThought(db, { title: b.title, body: b.body, tags: b.tags }, editorOf(req, b.model))).id);
  });

  // Notes carry no author: they are always the owner's (spec §4).
  created(app, '/v1/notes', async (req) => {
    const b = parseBody(noteBody, req.body);
    const projectId = b.project === undefined ? null : await requireAppProject(db, b.project, 'project');
    return ids((await createNote(db, { projectId, title: b.title, body: b.body, tags: b.tags })).id);
  });

  created(app, '/v1/reports', async (req) => {
    const b = parseBody(reportBody, req.body);
    const projectId = b.project === undefined ? null : await requireAppProject(db, b.project, 'project');
    return ids((await createReport(db, { projectId, title: b.title, body: b.body }, editorOf(req, b.model))).id);
  });

  // An attachment is the raw request body (no multipart), streamed to disk by the shared upload path.
  await app.register(async (upload) => {
    upload.removeAllContentTypeParsers();
    upload.addContentTypeParser('*', (_req, _payload, done) => done(null));
    created(upload, '/v1/reports/:id/attachments', async (req, reply) => {
      const params = reportParams.safeParse(req.params);
      if (!params.success) {
        reply.header('connection', 'close');
        throw new AppApiError(404, 'report_not_found', 'no report has this id');
      }
      try {
        const a = await receiveAttachment(deps, req, reply, params.data.id, { header: 'X-Filename', value: req.headers['x-filename'] }, editorOf(req));
        return { status: 201, body: { id: a.id, kind: a.kind, mime: a.mime, size: a.size } };
      } catch (e) {
        throw translate(e, { not_found: 'report_not_found', conflict: 'report_closed' });
      }
    });
  });
};

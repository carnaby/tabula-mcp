import { refOf } from '@tabula/shared/refs';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { appAuth, type AuthContext, insufficientScope, type Principal } from '../auth/authenticate.js';
import { INBOX_READ } from '../auth/settings.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { DomainError } from '../domain/errors.js';
import { createMessage, findMessageByRef, listMessageHeaders, MESSAGE_STATUSES, MESSAGE_TYPES, type Message, messageSummaryView, WAITING_ON } from '../domain/messages.js';
import { createNote } from '../domain/notes.js';
import { listProjects, requireProject } from '../domain/projects.js';
import { createReport } from '../domain/reports.js';
import { createThought } from '../domain/thoughts.js';
import { AUTHOR_SENDER, normalizeModel } from '../domain/validation.js';
import type { MediaStore } from '../media/store.js';
import { AppApiError, errorBody, logAppError, parseBody, toAppError, translate, validationFailed } from './app-api-errors.js';
import { idempotent } from './app-idempotency.js';
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

/** A project an app may write to or filter by: an existing one, never "global". The API creates no projects. */
export async function requireAppProject(db: Db, slug: string, field: 'to' | 'from' | 'project'): Promise<string> {
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

/** Most message headers one GET /v1/messages returns (inbox-read spec §3). */
const MESSAGE_LIST_MAX = 200;
const MESSAGE_LIST_DEFAULT = 50;
/** The query of GET /v1/messages: a repeated parameter arrives as an array and an empty one as "", both refused. */
const messagesQuery = z.strictObject({
  to: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  status: z.enum([...MESSAGE_STATUSES, 'open', 'archive', 'all']).optional(),
  waiting_on: z.enum(WAITING_ON).optional(),
  limit: z
    .string()
    .regex(/^[0-9]{1,3}$/, `must be a whole number from 1 to ${MESSAGE_LIST_MAX}`)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MESSAGE_LIST_MAX))
    .optional(),
});

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
  // Bodies are JSON (an upload has its own parser): any other type is refused with 415. The raw JSON text is kept for
  // the idempotency fingerprint (spec §5); parsing stays Fastify's own, with its prototype-poisoning checks.
  const rawBodies = new WeakMap<FastifyRequest, string>();
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('text/plain');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    rawBodies.set(req, body as string);
    parseJson(req, body as string, done);
  });

  /** What identifies a request for its Idempotency-Key: the raw JSON, or for an upload the headers that describe the file. */
  const partsOf = (req: FastifyRequest, kind: 'json' | 'upload'): string[] =>
    kind === 'json'
      ? [req.method, req.url, rawBodies.get(req) ?? '']
      : [req.method, req.url, ...['content-length', 'content-type', 'x-filename'].map((h) => String(req.headers[h] ?? ''))];

  /** A POST that creates something, at most once per Idempotency-Key; `run` says what to answer. */
  const created = (
    instance: FastifyInstance,
    path: string,
    run: (req: FastifyRequest, reply: FastifyReply) => Promise<Created>,
    kind: 'json' | 'upload' = 'json',
  ) =>
    instance.post(path, (req, reply) =>
      idempotent(db, req, reply, { connectionId: connectionOf(req).connectionId, parts: partsOf(req, kind), bodyUnread: kind === 'upload' }, () =>
        run(req, reply),
      ),
    );

  /**
   * A read needs a scope on top of `app` (inbox-read spec §2.2). Checked before anything about the request is looked
   * at, so a connection without it learns nothing, not even whether its query would pass.
   */
  const requireScope = (req: FastifyRequest, reply: FastifyReply, scope: string): void => {
    if (connectionOf(req).scopes.includes(scope)) return;
    reply.header('WWW-Authenticate', insufficientScope(deps.authCtx.auth, 'app', `app ${scope}`));
    throw new AppApiError(
      403,
      'insufficient_scope',
      `this token lacks the scope "${scope}". If the connection was approved without it, connect the app again with scope "app ${scope}"; if a refresh with a narrower scope dropped it, refresh without "scope" to get it back.`,
    );
  };

  // When the web UI is served, its wildcard GET (and HEAD) route at the root would answer an unknown GET here before
  // the 404 handler, without authentication and in the root's shape; this more specific wildcard keeps it in the API.
  app.get('/*', async () => {
    throw new AppApiError(404, 'not_found', 'no such endpoint in the App API');
  });
  // The wildcard does not match the bare prefix: '/' here is both /app-api and /app-api/.
  app.get('/', async () => {
    throw new AppApiError(404, 'not_found', 'no such endpoint in the App API');
  });

  app.get('/v1/projects', async () => ({
    items: (await listProjects(db)).filter((p) => p.id !== 'global').map((p) => ({ slug: p.id, name: p.name, description: p.description })),
  }));

  // Headers only, across all projects unless filtered (inbox-read spec §3); the body of a message never leaves here.
  app.get('/v1/messages', async (req, reply) => {
    requireScope(req, reply, INBOX_READ);
    const q = parseBody(messagesQuery, req.query);
    const to = q.to === undefined ? undefined : await requireAppProject(db, q.to, 'to');
    const from = q.from === undefined || q.from === AUTHOR_SENDER ? q.from : await requireAppProject(db, q.from, 'from');
    const r = await listMessageHeaders(db, { to, from, status: q.status ?? 'open', waitingOn: q.waiting_on, limit: q.limit ?? MESSAGE_LIST_DEFAULT });
    return { items: r.items.map(messageSummaryView), truncated: r.truncated };
  });

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
    created(
      upload,
      '/v1/reports/:id/attachments',
      async (req, reply) => {
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
      },
      'upload',
    );
  });
};

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import {
  addAttachment, type Attachment, CLOSED_REPORT, createReport, deleteAttachment, deleteReport, frameAt, listAttachments, openReportCounts,
  pageReports, parseTimestamp, REPORT_SORTS, REPORT_STATUSES, requireAttachment, requireReport, updateReport,
} from '../domain/reports.js';
import { MAX_PAGE_SIZE } from '../domain/paging.js';
import { badRequest, conflict, notFound } from '../domain/errors.js';
import { signMediaPath, verifyMediaSignature } from '../media/sign.js';
import type { MediaStore } from '../media/store.js';
import { parse } from './parse.js';

const HUMAN = { source: 'human' as const, label: 'human' };
/** Links handed to the UI stay valid for half a day. */
const UI_LINK_TTL = 12 * 3600;

const idParams = z.object({ id: z.uuid() });

export const attachmentView = (a: Attachment, token: string, ttl = UI_LINK_TTL) => ({
  id: a.id,
  reportId: a.reportId,
  kind: a.kind,
  mime: a.mime,
  size: a.size,
  fileName: a.fileName,
  durationMs: a.durationMs,
  sourceId: a.sourceId,
  atMs: a.atMs,
  createdBy: a.createdBy,
  createdAt: a.createdAt,
  purgedAt: a.purgedAt,
  url: a.purgedAt ? null : signMediaPath(token, a.id, ttl),
});

export type MediaDeps = { db: Db; config: Config; store: MediaStore };

export const reportRoutes: FastifyPluginAsync<MediaDeps> = async (app, { db, config, store }) => {
  const token = config.token;
  const paths = config.media;

  app.get('/reports', (req) => {
    const q = parse(
      z.object({
        project: z.string().optional(),
        status: z.enum([...REPORT_STATUSES, 'open', 'all']).optional(),
        q: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
        sort: z.enum(REPORT_SORTS).optional(),
        dir: z.enum(['asc', 'desc']).optional(),
      }),
      req.query,
    );
    const { project, ...rest } = q;
    return pageReports(db, { ...rest, projectId: project });
  });

  app.get('/reports/counts', () => openReportCounts(db));

  app.post('/reports', async (req, reply) => {
    const b = parse(z.object({ projectId: z.string(), title: z.string().optional(), body: z.string().optional() }), req.body);
    return reply.code(201).send(await createReport(db, b, HUMAN));
  });

  app.get('/reports/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const report = await requireReport(db, id);
    return { ...report, attachments: (await listAttachments(db, id)).map((a) => attachmentView(a, token)) };
  });

  app.patch('/reports/:id', (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(
      z.object({
        title: z.string().optional(),
        body: z.string().optional(),
        triage: z.string().optional(),
        status: z.enum(REPORT_STATUSES).optional(),
        projectId: z.string().optional(),
        expectedVersion: z.number().int().positive().optional(),
      }),
      req.body,
    );
    return updateReport(db, id, b, HUMAN);
  });

  app.delete('/reports/:id', async (req, reply) => {
    await deleteReport(db, store, parse(idParams, req.params).id);
    return reply.code(204).send();
  });

  app.delete('/attachments/:id', async (req, reply) => {
    await deleteAttachment(db, store, parse(idParams, req.params).id);
    return reply.code(204).send();
  });

  /** A still from a video at a moment (the UI's "save frame" while the video is paused). */
  app.post('/attachments/:id/frame', async (req) => {
    const { id } = parse(idParams, req.params);
    const { at } = parse(z.object({ at: z.union([z.number(), z.string()]) }), req.body);
    const { frame } = await frameAt(db, store, paths, id, parseTimestamp(at), HUMAN);
    return attachmentView(frame, token);
  });

  // Uploads: the raw file is the request body (no multipart), streamed straight to disk.
  await app.register(async (upload) => {
    upload.removeAllContentTypeParsers();
    upload.addContentTypeParser('*', (_req, _payload, done) => done(null));
    upload.post('/reports/:id/attachments', async (req, reply) => {
      const { id } = parse(idParams, req.params);
      // Refusals that don't need the body come before it is read (it may be a gigabyte); the body is then left
      // unread, so the connection is closed after the reply.
      try {
        if ((await requireReport(db, id)).status === 'done') throw conflict(CLOSED_REPORT);
        await store.ensureWritable();
      } catch (e) {
        reply.header('connection', 'close');
        throw e;
      }
      const declared = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined;
      const rawName = req.headers['x-file-name'];
      let fileName: string | undefined;
      try {
        fileName = typeof rawName === 'string' ? decodeURIComponent(rawName) : undefined;
      } catch {
        throw badRequest('X-File-Name must be URI-encoded');
      }
      let file;
      try {
        file = await store.receive(req.raw, declared);
      } catch (e) {
        // The rest of a refused upload is not worth reading; close the connection after the error reply.
        reply.header('connection', 'close');
        throw e;
      }
      const a = await addAttachment(db, store, paths, id, file, fileName, HUMAN);
      return reply.code(201).send(attachmentView(a, token));
    });
  });
};

/** GET /media/<id>?exp=&sig= — outside /api: the signature replaces the bearer token. */
export function registerMediaRoute(app: FastifyInstance, { db, config, store }: MediaDeps): void {
  app.get('/media/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const q = parse(z.object({ exp: z.coerce.number().int(), sig: z.string().max(100) }), req.query);
    if (!verifyMediaSignature(config.token, id, q.exp, q.sig)) {
      return reply.code(403).send({ error: 'forbidden', message: 'the link is invalid or expired; reload the report' });
    }
    const a = await requireAttachment(db, id);
    if (a.purgedAt) return reply.code(410).send({ error: 'gone', message: 'deleted after the report was closed' });
    const size = await store.size(a.storageKey);
    if (size === null) throw notFound('the file is missing from the media directory');

    reply
      .header('Content-Type', a.mime)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=3600')
      .header('Accept-Ranges', 'bytes')
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.fileName)}`);

    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      let start: number;
      let end: number;
      if (range[1]) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(range[2]));
        end = size - 1;
      }
      if (start > end || start >= size) {
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      }
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Content-Length', end - start + 1)
        .send(store.open(a.storageKey, { start, end }));
    }
    return reply.header('Content-Length', size).send(store.open(a.storageKey));
  });
}

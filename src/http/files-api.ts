import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  deleteFile, FILE_LIMITS, getFile, getFileRevision, listFileRevisions, listFiles, putFile, restoreFile, setStatePaths,
} from '../domain/files.js';
import { sanitizeAgentLabel } from '../domain/validation.js';
import { parse } from './parse.js';

/**
 * JSON escaping can make a body several times larger than the file (a control character becomes a 6-character
 * escape), so the PUT route accepts more than Fastify's default 1 MiB; the domain enforces the real 1 MiB limit.
 */
const PUT_BODY_LIMIT = 8 * FILE_LIMITS.contentBytes;

const idParams = z.object({ id: z.string() });
const pathQuery = z.object({ path: z.string() });

/** The CLI sends X-Tabula-Agent: cli; the UI sends no agent header and writes as the human. */
function writer(req: FastifyRequest): string {
  const header = req.headers['x-tabula-agent'];
  return header ? sanitizeAgentLabel(header) : 'human';
}

export const fileRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/projects/:id/files', (req) => {
    const { id } = parse(idParams, req.params);
    const { deleted } = parse(z.object({ deleted: z.enum(['0', '1']).optional() }), req.query);
    return listFiles(db, id, { includeDeleted: deleted === '1' });
  });

  app.get('/projects/:id/files/content', (req) =>
    getFile(db, parse(idParams, req.params).id, parse(pathQuery, req.query).path),
  );

  app.put('/projects/:id/files', { bodyLimit: PUT_BODY_LIMIT }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const b = parse(
      z.object({ path: z.string(), content: z.string(), base_sha256: z.string().nullable(), force: z.boolean().optional() }),
      req.body,
    );
    const r = await putFile(db, id, { path: b.path, content: b.content, baseSha256: b.base_sha256, force: b.force }, writer(req));
    if (!r.ok) {
      return reply.code(409).send({ error: 'conflict', message: 'the file changed on the server since your base version', sha256: r.sha256 });
    }
    return { sha256: r.sha256, version: r.version, changed: r.changed };
  });

  app.delete('/projects/:id/files', (req) =>
    deleteFile(db, parse(idParams, req.params).id, parse(pathQuery, req.query).path),
  );

  app.post('/projects/:id/files/restore', (req) =>
    restoreFile(db, parse(idParams, req.params).id, parse(pathQuery, req.body).path),
  );

  app.get('/projects/:id/files/revisions', (req) =>
    listFileRevisions(db, parse(idParams, req.params).id, parse(pathQuery, req.query).path),
  );

  app.get('/projects/:id/files/revisions/content', (req) => {
    const q = parse(z.object({ path: z.string(), version: z.coerce.number().int().min(1) }), req.query);
    return getFileRevision(db, parse(idParams, req.params).id, q.path, q.version);
  });

  app.put('/projects/:id/files/state', (req) => {
    const { paths } = parse(z.object({ paths: z.array(z.string()).max(10_000) }), req.body);
    return setStatePaths(db, parse(idParams, req.params).id, paths);
  });
};

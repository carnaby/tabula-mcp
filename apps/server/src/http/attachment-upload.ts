import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { badRequest, conflict } from '../domain/errors.js';
import { addAttachment, type Attachment, CLOSED_REPORT, type Editor, requireReport } from '../domain/reports.js';
import type { MediaStore } from '../media/store.js';

/** A URI-encoded file name header (the browser's encodeURIComponent); undefined when absent. */
function decodeFileName(h: { header: string; value: unknown }): string | undefined {
  if (typeof h.value !== 'string') return undefined;
  try {
    return decodeURIComponent(h.value);
  } catch {
    throw badRequest(`${h.header} must be URI-encoded`);
  }
}

/**
 * The raw request body as a new attachment of a report, streamed to disk (shared by /api and /app-api). Refusals that
 * need no body come before it is read (it may be a gigabyte); whenever the body is left unread, the connection is
 * closed after the reply.
 */
export async function receiveAttachment(
  deps: { db: Db; config: Config; store: MediaStore },
  req: FastifyRequest,
  reply: FastifyReply,
  reportId: string,
  fileName: { header: string; value: unknown },
  editor: Editor,
): Promise<Attachment> {
  let name: string | undefined;
  try {
    if ((await requireReport(deps.db, reportId)).status === 'done') throw conflict(CLOSED_REPORT);
    await deps.store.ensureWritable();
    name = decodeFileName(fileName);
  } catch (e) {
    reply.header('connection', 'close');
    throw e;
  }
  const declared = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined;
  let file;
  try {
    file = await deps.store.receive(req.raw, declared);
  } catch (e) {
    // The rest of a refused upload is not worth reading; close the connection after the error reply.
    reply.header('connection', 'close');
    throw e;
  }
  return addAttachment(deps.db, deps.store, deps.config.media, reportId, file, name, editor);
}

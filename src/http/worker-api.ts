import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import {
  claimJob, type ClaimedJob, completeJob, failJob, heartbeatJob, jobSignal, queuedCount, releaseJob, touchWorker,
} from '../domain/jobs.js';
import { signMediaPath } from '../media/sign.js';
import { requireBearer } from './auth.js';
import { parse } from './parse.js';

/** The longest a claim waits for work before answering 204. */
export const MAX_CLAIM_WAIT_S = 30;
/** Media links handed to the worker: long enough for a slow download. */
const WORKER_LINK_TTL = 6 * 3600;
/** A transcript of hours of speech is a few hundred kilobytes of JSON. */
const COMPLETE_BODY_LIMIT = 4 * 1024 * 1024;

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** The worker's host name from X-Tabula-Worker, lower-cased; anything odd becomes "worker". */
export function workerName(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return NAME.test(v) ? v : 'worker';
}
const workerVersion = (raw: unknown): string | null => (typeof raw === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(raw) ? raw : null);

const idParams = z.object({ id: z.uuid() });
const lease = z.uuid();

const jobView = (c: ClaimedJob, token: string) => ({
  id: c.job.id,
  lease: c.job.leaseId,
  lease_until: c.job.leaseUntil?.toISOString() ?? null,
  attempt: c.job.attempts,
  kind: c.job.kind,
  attachment: {
    id: c.attachment.id, kind: c.attachment.kind, mime: c.attachment.mime, size: c.attachment.size,
    duration_ms: c.attachment.durationMs, file_name: c.attachment.fileName,
  },
  // Relative to the server URL; the signature replaces the token, so the worker never needs TABULA_TOKEN.
  media_path: signMediaPath(token, c.attachment.id, WORKER_LINK_TTL),
  report: { id: c.report.id, project: c.report.projectId, title: c.report.title },
});

/**
 * /api/worker/*: the transcription worker's API. Only TABULA_WORKER_TOKEN opens it, and that token opens nothing else
 * (the rest of /api and /mcp check TABULA_TOKEN). Without TABULA_WORKER_TOKEN every call answers 503.
 */
export const workerRoutes: FastifyPluginAsync<{ db: Db; config: Config }> = async (app, { db, config }) => {
  const auth = config.workerToken ? requireBearer(config.workerToken) : null;
  // On shutdown waiting claims answer "no job" at once instead of holding the close up for up to 30 s.
  const closing = new AbortController();
  app.addHook('preClose', async () => closing.abort());
  // onRequest: refused before the body is read (a complete body may be megabytes).
  app.addHook('onRequest', async (req, reply) => {
    if (!auth) {
      return reply
        .code(503)
        .send({ error: 'unavailable', message: 'the transcription worker is not enabled on this server: set TABULA_WORKER_TOKEN' });
    }
    return auth(req, reply);
  });
  // Every authenticated call is a sign of life ("worker last seen" in the UI).
  app.addHook('preHandler', async (req) => {
    await touchWorker(db, workerName(req.headers['x-tabula-worker']), workerVersion(req.headers['x-tabula-version']));
  });

  app.get('/ping', async () => ({ ok: true, queued: await queuedCount(db) }));

  app.post('/jobs/claim', async (req, reply) => {
    const { wait } = parse(z.object({ wait: z.number().int().min(0).max(MAX_CLAIM_WAIT_S).default(MAX_CLAIM_WAIT_S) }), req.body ?? {});
    const name = workerName(req.headers['x-tabula-worker']);
    const deadline = Date.now() + wait * 1000;
    // Waiting ends when the worker hangs up (stopped, or its network went away) or the server shuts down.
    const stop = new AbortController();
    let gone = req.raw.socket?.destroyed === true;
    const hangUp = () => {
      gone = true;
      stop.abort();
    };
    const shutDown = () => stop.abort();
    reply.raw.on('close', hangUp);
    closing.signal.addEventListener('abort', shutDown, { once: true });
    if (gone || closing.signal.aborted) stop.abort();
    try {
      for (;;) {
        // Checked before every claim: a job taken for a worker that is gone would cost an attempt and wait out the lease.
        if (stop.signal.aborted) return reply.code(204).send();
        const claimed = await claimJob(db, name);
        if (claimed) {
          if (!gone) return jobView(claimed, config.token);
          // The worker hung up while the claim ran: give the job and its attempt back instead of sending it to nobody.
          await releaseJob(db, claimed.job.id, claimed.job.leaseId!);
          return reply.code(204).send();
        }
        const left = deadline - Date.now();
        if (left <= 0) return reply.code(204).send();
        // Woken at once by a new job; every 5 s anyway, for jobs whose back-off or lease ran out meanwhile.
        await jobSignal.wait(Math.min(left, 5000), stop.signal);
      }
    } finally {
      closing.signal.removeEventListener('abort', shutDown);
      reply.raw.off('close', hangUp);
    }
  });

  app.post('/jobs/:id/heartbeat', async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ lease }), req.body);
    const { leaseUntil } = await heartbeatJob(db, id, b.lease);
    return { lease_until: leaseUntil.toISOString() };
  });

  app.post('/jobs/:id/complete', { bodyLimit: COMPLETE_BODY_LIMIT }, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(
      z.object({
        lease,
        language: z.string().max(20).nullable(),
        model: z.string().min(1).max(200),
        duration_ms: z.number().int().min(0).nullable(),
        segments: z.array(z.object({ start_ms: z.number(), end_ms: z.number(), text: z.string() })),
      }),
      req.body,
    );
    const r = await completeJob(db, id, b.lease, { language: b.language, model: b.model, durationMs: b.duration_ms, segments: b.segments });
    return { ok: true, segments: r.segments };
  });

  app.post('/jobs/:id/fail', async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ lease, error: z.string().max(10_000), permanent: z.boolean().optional() }), req.body);
    const r = await failJob(db, id, b.lease, { error: b.error, permanent: b.permanent });
    return { status: r.status, retry_at: r.retryAt?.toISOString() ?? null };
  });

  app.post('/jobs/:id/release', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ lease }), req.body);
    await releaseJob(db, id, b.lease);
    return reply.code(204).send();
  });
};

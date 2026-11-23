import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import { loggableError } from '../domain/errors.js';
import { type Claim, claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../domain/idempotency.js';
import type { Created } from './app-api.js';
import { AppApiError, validationFailed } from './app-api-errors.js';

/** 1 to 200 printable ASCII characters (spec §5). */
const KEY = /^[\x20-\x7e]{1,200}$/;

/** SHA-256 over the parts, each prefixed with its length in bytes, so two different lists never hash alike. */
export function fingerprintOf(parts: readonly string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(`${Buffer.byteLength(p)}:`).update(p);
  return h.digest('hex');
}

/** The Idempotency-Key of a request, or undefined when it sends none. */
export function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !KEY.test(raw)) {
    throw validationFailed([{ path: 'Idempotency-Key', message: 'must be 1 to 200 printable ASCII characters' }]);
  }
  return raw;
}

/**
 * Runs a POST at most once per key and connection (spec §5): a repeat of the same request gets the stored answer with
 * Idempotent-Replayed, a different request under the key 422, a repeat while the first still runs 409. A failed or
 * interrupted run frees the key, so the client can try again. `bodyUnread`: the run reads the body itself (an
 * upload), so an answer given without running it closes the connection after the reply.
 */
export async function idempotent(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  request: { connectionId: string; parts: readonly string[]; bodyUnread: boolean },
  run: () => Promise<Created>,
): Promise<FastifyReply> {
  let key: string | undefined;
  let claim: Claim | undefined;
  try {
    key = idempotencyKeyOf(req);
    if (key !== undefined) claim = await claimIdempotencyKey(db, { connectionId: request.connectionId, key, fingerprint: fingerprintOf(request.parts), now: new Date() });
  } catch (e) {
    // Refused (or failed) before the run: an unread body is not worth reading.
    if (request.bodyUnread) reply.header('connection', 'close');
    throw e;
  }
  if (key === undefined || claim === undefined) {
    const r = await run();
    return reply.code(r.status).send(r.body);
  }
  const ref = { connectionId: request.connectionId, key };
  if (claim.kind !== 'claimed' && request.bodyUnread) reply.header('connection', 'close');
  if (claim.kind === 'replay') return reply.code(claim.status).header('idempotent-replayed', 'true').send(claim.body);
  if (claim.kind === 'mismatch') {
    throw new AppApiError(422, 'idempotency_key_reused', 'this Idempotency-Key was already used for a different request; send a new key');
  }
  if (claim.kind === 'in_progress') {
    throw new AppApiError(409, 'request_in_progress', 'a request with this Idempotency-Key is still running; try again in a moment');
  }
  let completed = false;
  try {
    const r = await run();
    await completeIdempotencyKey(db, { ...ref, status: r.status, body: r.body });
    completed = true;
    return reply.code(r.status).send(r.body);
  } finally {
    if (!completed) {
      await releaseIdempotencyKey(db, ref).catch((e: unknown) => req.log.error({ err: loggableError(e) }, 'could not free an Idempotency-Key'));
    }
  }
}

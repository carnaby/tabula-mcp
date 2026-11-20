import type { FastifyReply, FastifyRequest } from 'fastify';
import { clientKey, FixedWindows } from '../rate-limit.js';

/** An OAuth error (RFC 6749 §5.2, RFC 7591 §3.2.2): a fixed code and a fixed description, never what the caller sent or a secret. */
export function sendOAuthError(reply: FastifyReply, status: number, error: string, description: string): FastifyReply {
  return reply.code(status).header('cache-control', 'no-store').send({ error, error_description: description });
}

/** An onRequest hook (before the body is read): at most `limit` requests per address and window, then 429 slow_down. */
export function perAddressLimit(limit: number, windowMs: number, description: string) {
  const windows = new FixedWindows(windowMs);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (windows.add(clientKey(req), Date.now()) <= limit) return;
    reply.header('retry-after', String(Math.ceil(windowMs / 1000)));
    return sendOAuthError(reply, 429, 'slow_down', description);
  };
}

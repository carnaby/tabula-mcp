import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

const digest = (s: string) => createHash('sha256').update(s).digest();

export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b)) && a.length === b.length;
}

/** The token of an `Authorization: Bearer <token>` header, or undefined. */
export const bearerToken = (req: FastifyRequest): string | undefined => /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim();

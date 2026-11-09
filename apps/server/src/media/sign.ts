import { createHmac } from 'node:crypto';
import { safeEqual } from '../http/auth.js';

/**
 * Attachment URLs carry a signature instead of the bearer token: <img>, <video> and <audio> cannot send an
 * Authorization header, and an agent gets a link it can pass to curl. The key is derived from TABULA_TOKEN,
 * so rotating the token invalidates every link.
 */
const sig = (token: string, id: string, exp: number) =>
  createHmac('sha256', `tabula-media:${token}`).update(`${id}.${exp}`).digest('base64url');

/** Expiry is rounded up to the hour, so the same attachment keeps the same URL for a while (browser cache). */
export function signMediaPath(token: string, id: string, ttlSeconds: number, now = Date.now()): string {
  const hour = 3600;
  const exp = Math.ceil((now / 1000 + ttlSeconds) / hour) * hour;
  return `/media/${id}?exp=${exp}&sig=${sig(token, id, exp)}`;
}

export function verifyMediaSignature(token: string, id: string, exp: number, signature: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  return safeEqual(signature, sig(token, id, exp));
}

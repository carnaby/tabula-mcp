import { createHmac } from 'node:crypto';
import { safeEqual } from '../http/auth.js';

/**
 * Attachment URLs carry a signature instead of a credential: <img>, <video> and <audio> cannot send one, and an agent
 * gets a link it can pass to curl. The key is random and kept in settings (media/key.ts); deleting that row
 * invalidates every link.
 */
const sig = (key: string, id: string, exp: number) =>
  createHmac('sha256', `tabula-media:${key}`).update(`${id}.${exp}`).digest('base64url');

/** Expiry is rounded up to the hour, so the same attachment keeps the same URL for a while (browser cache). */
export function signMediaPath(key: string, id: string, ttlSeconds: number, now = Date.now()): string {
  const hour = 3600;
  const exp = Math.ceil((now / 1000 + ttlSeconds) / hour) * hour;
  return `/media/${id}?exp=${exp}&sig=${sig(key, id, exp)}`;
}

export function verifyMediaSignature(key: string, id: string, exp: number, signature: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  return safeEqual(signature, sig(key, id, exp));
}

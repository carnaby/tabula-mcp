import type { AuthSettings } from './settings.js';

/** One cookie by its exact name from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The session cookie: HttpOnly (no script reads it), SameSite=Strict (no other site sends it), Secure on https. */
export function sessionCookie(auth: AuthSettings, value: string, maxAgeMs: number): string {
  const parts = [`${auth.cookie.name}=${value}`, 'Path=/', `Max-Age=${Math.floor(maxAgeMs / 1000)}`, 'HttpOnly', 'SameSite=Strict'];
  if (auth.cookie.secure) parts.push('Secure');
  return parts.join('; ');
}

export const clearedSessionCookie = (auth: AuthSettings): string => sessionCookie(auth, '', 0);

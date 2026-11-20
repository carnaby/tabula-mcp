import { createHash, timingSafeEqual } from 'node:crypto';

/** RFC 7636 §4.1: `code-verifier = 43*128unreserved`. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/** An S256 challenge is the base64url of a SHA-256 digest: exactly 43 characters without padding. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Whether `challenge` can be an S256 challenge at all; checked at /oauth/authorize, so a request that can never be redeemed is refused there. */
export function isS256Challenge(challenge: string): boolean {
  return S256_CHALLENGE.test(challenge);
}

/** RFC 7636 §4.6, S256 only, constant-time. A verifier outside the RFC's alphabet or length is refused before hashing. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier) || !S256_CHALLENGE.test(challenge)) return false;
  const computed = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'), 'ascii');
  const expected = Buffer.from(challenge, 'ascii');
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `http://<loopback host>`, an optional port, then the end, a path or a query: `localhost.evil.example` does not match. */
const LOOPBACK_AUTHORITY = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(?=[/?]|$)/;

function withoutLoopbackPort(uri: string): string | null {
  const match = LOOPBACK_AUTHORITY.exec(uri);
  if (match === null || !LOOPBACK_HOSTS.has(match[1] ?? '')) return null;
  return `http://${match[1] ?? ''}${uri.slice(match[0].length)}`;
}

/** A loopback http URI: an app on the owner's own computer (Claude Code, the tabula CLI). */
export function isLoopbackRedirect(uri: string): boolean {
  return withoutLoopbackPort(uri) !== null;
}

/**
 * Whether a presented redirect_uri is the registered one: exact string comparison (OAuth 2.1 §4.1.1), except that the
 * port of a loopback http URI is ignored (RFC 8252 §7.3: a native app binds an ephemeral port). Textual on purpose:
 * nothing a URL parser would normalise can make two different strings match.
 */
export function redirectMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  const a = withoutLoopbackPort(registered);
  const b = withoutLoopbackPort(presented);
  return a !== null && b !== null && a === b;
}

const MAX_REDIRECT_LENGTH = 512;
/** Printable ASCII without the space: anything else would reach a Location header. */
const URI_CHARACTERS = /^[\x21-\x7e]+$/;

/** Whether a client may register this redirect URI: https with a host, or http on a loopback host; no fragment, no user, ≤ 512 characters. */
export function isAllowedRedirect(uri: string): boolean {
  if (uri.length > MAX_REDIRECT_LENGTH || !URI_CHARACTERS.test(uri) || uri.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return url.hostname !== '';
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname);
  return false;
}

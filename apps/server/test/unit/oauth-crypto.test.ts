import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isAllowedRedirect, isLoopbackRedirect, isS256Challenge, redirectMatches, verifyPkceS256 } from '../../src/auth/oauth/crypto.js';

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

describe('PKCE S256', () => {
  it('accepts the matching verifier only', () => {
    const p = pkce();
    expect(isS256Challenge(p.challenge)).toBe(true);
    expect(verifyPkceS256(p.verifier, p.challenge)).toBe(true);
    expect(verifyPkceS256(pkce().verifier, p.challenge)).toBe(false);
  });

  it('refuses a verifier outside RFC 7636 and a plain challenge', () => {
    const p = pkce();
    expect(verifyPkceS256(p.verifier.slice(0, 42), p.challenge)).toBe(false);
    expect(verifyPkceS256(`${p.verifier}!`, p.challenge)).toBe(false);
    // A 64-character verifier: a 43-character one would itself have the shape of an S256 challenge.
    const plain = randomBytes(48).toString('base64url');
    expect(isS256Challenge(plain)).toBe(false);
    expect(verifyPkceS256(plain, plain)).toBe(false);
  });
});

describe('redirect URIs', () => {
  it('match exactly, except the port of a loopback http URI', () => {
    expect(redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectMatches('https://claude.ai/cb', 'https://claude.ai:444/cb')).toBe(false);
    expect(redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:53111/callback')).toBe(true);
    expect(redirectMatches('http://localhost:1/callback', 'http://localhost:2/callback')).toBe(true);
    expect(redirectMatches('http://localhost/callback', 'http://127.0.0.1/callback')).toBe(false);
    expect(redirectMatches('http://localhost/callback', 'http://localhost/other')).toBe(false);
    expect(redirectMatches('http://localhost/cb', 'http://localhost.evil.example/cb')).toBe(false);
    expect(isLoopbackRedirect('http://[::1]:9/cb')).toBe(true);
    expect(isLoopbackRedirect('https://localhost/cb')).toBe(false);
  });

  it('may be registered only as https with a host or loopback http', () => {
    expect(isAllowedRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isAllowedRedirect('http://127.0.0.1/callback')).toBe(true);
    for (const bad of ['http://client.example.com/cb', 'myapp://cb', 'https://client.example.com/cb#x', 'https://u:p@client.example.com/cb', `https://client.example.com/${'a'.repeat(512)}`, 'https://client.example.com/a b']) {
      expect(isAllowedRedirect(bad), bad).toBe(false);
    }
  });
});

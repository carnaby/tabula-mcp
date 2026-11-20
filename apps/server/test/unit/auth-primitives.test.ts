import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { connectionNameProblem, displayClientName, isDisplayableClientName, suggestConnectionName } from '../../src/auth/names.js';
import { clientKey, FixedWindows } from '../../src/auth/rate-limit.js';
import { hashSecret, newSecret } from '../../src/auth/secrets.js';

const req = (headers: Record<string, string | string[]>, remote = '10.0.0.9') =>
  ({ headers, socket: { remoteAddress: remote } }) as unknown as FastifyRequest;

describe('secrets', () => {
  it('are 32 random bytes in base64url, stored as SHA-256 hex', () => {
    const a = newSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSecret()).not.toBe(a);
    expect(hashSecret('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('FixedWindows', () => {
  it('counts per key within the window and starts again after it', () => {
    const w = new FixedWindows(60_000);
    expect(w.add('a', 0)).toBe(1);
    expect(w.add('a', 59_999)).toBe(2);
    expect(w.count('a', 59_999)).toBe(2);
    expect(w.add('b', 1)).toBe(1);
    expect(w.count('a', 60_000)).toBe(0);
    expect(w.add('a', 60_000)).toBe(1);
  });

  it('forgets the oldest key past its capacity', () => {
    const w = new FixedWindows(60_000, 2);
    w.add('a', 0);
    w.add('b', 0);
    w.add('c', 0);
    expect(w.count('a', 1)).toBe(0);
    expect(w.count('c', 1)).toBe(1);
  });
});

describe('clientKey', () => {
  it('takes the address the nearest proxy added, else the socket', () => {
    expect(clientKey(req({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientKey(req({ 'x-forwarded-for': '198.51.100.1, 203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientKey(req({ 'x-forwarded-for': ['198.51.100.1', '203.0.113.8'] }))).toBe('203.0.113.8');
    expect(clientKey(req({}))).toBe('10.0.0.9');
    expect(clientKey(req({ 'x-forwarded-for': ' , ' }))).toBe('10.0.0.9');
  });
});

describe('connection names', () => {
  it('follow the agent label rules and never "human"', () => {
    expect(connectionNameProblem('claude-code')).toBeNull();
    expect(connectionNameProblem('gemini_cli.2')).toBeNull();
    for (const bad of ['', 'Claude', 'a b', 'x'.repeat(41), 'é']) expect(connectionNameProblem(bad), bad).toMatch(/1 to 40/);
    expect(connectionNameProblem('human')).toMatch(/reserved/);
  });

  it('are suggested from the redirect host or the client name', () => {
    expect(suggestConnectionName('Claude', 'https://claude.ai/api/mcp/auth_callback')).toBe('claude-ai');
    expect(suggestConnectionName(null, 'https://claude.com/api/mcp/auth_callback')).toBe('claude-ai');
    expect(suggestConnectionName('Claude Code', 'http://localhost:4567/callback')).toBe('claude-code');
    expect(suggestConnectionName('  Gemini CLI MCP Client ', 'http://127.0.0.1:1/cb')).toBe('gemini-cli-mcp-client');
    expect(suggestConnectionName('Čučoriedka', 'http://127.0.0.1:1/cb')).toBe('cucoriedka');
    expect(suggestConnectionName('Human', 'http://127.0.0.1:1/cb')).toBe('app');
    expect(suggestConnectionName('', 'http://127.0.0.1:1/cb')).toBe('app');
    expect(suggestConnectionName('x'.repeat(80), 'http://127.0.0.1:1/cb')).toHaveLength(40);
  });

  it('show a client name only when it cannot lie about itself', () => {
    expect(isDisplayableClientName('Claude Code')).toBe(true);
    expect(isDisplayableClientName(`Claude${String.fromCharCode(0x202e)}edoC`)).toBe(false);
    expect(isDisplayableClientName(`a${String.fromCharCode(10)}b`)).toBe(false);
    expect(displayClientName(null)).toBe('Unnamed app');
    expect(displayClientName(`x${String.fromCharCode(0x200b)}`)).toBe('Unnamed app');
    expect(displayClientName('Claude')).toBe('Claude');
  });
});

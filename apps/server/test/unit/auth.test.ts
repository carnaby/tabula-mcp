import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { apiEditor } from '../../src/auth/authenticate.js';
import { bearerToken, safeEqual } from '../../src/http/auth.js';

const req = (principal: unknown, headers: Record<string, string> = {}) => ({ principal, headers }) as unknown as FastifyRequest;

describe('safeEqual', () => {
  it('compares strings of any length without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('apiEditor', () => {
  it('is the human only for the web UI', () => {
    expect(apiEditor(req({ kind: 'session', session: {} }))).toEqual({ source: 'human', label: 'human' });
    expect(apiEditor(req({ kind: 'oauth', connectionId: 'c', name: 'tabula-cli', scopes: ['api'] }))).toEqual({ source: 'agent', label: 'tabula-cli' });
  });
});

describe('bearerToken', () => {
  it('reads the token of an Authorization: Bearer header', () => {
    expect(bearerToken(req(null, { authorization: 'Bearer  abc ' }))).toBe('abc');
    expect(bearerToken(req(null, { authorization: 'bearer abc' }))).toBe('abc');
    expect(bearerToken(req(null, { authorization: 'Basic abc' }))).toBeUndefined();
    expect(bearerToken(req(null))).toBeUndefined();
  });
});

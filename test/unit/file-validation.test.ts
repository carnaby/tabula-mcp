import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FILE_LIMITS, validateFileContent, validateFilePath } from '../../src/domain/files.js';

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
};

describe('validateFilePath', () => {
  it.each([
    'docs/a.md', 'docs/handoff/2026-10-26 stav.md', '.superpowers/sdd/x/progress.md', 'a', 'docs/plány/čítaj.md',
    'docs/.envrc', 'env.md',
  ])('accepts %s', (p) => expect(validateFilePath(p)).toBe(p));

  it.each([
    ['', /empty/], ['/etc/passwd', /relative/], ['C:/x.md', /relative/], ['docs\\a.md', /forward slashes/],
    ['../a.md', /segments/], ['docs/../a.md', /segments/], ['docs//a.md', /segments/], ['docs/./a.md', /segments/],
    ['docs/', /segments/], ['.git/config', /segments/], ['.GIT/hooks/x', /segments/], ['.git./config', /segments/], ['.git /x', /segments/],
    ['Node_Modules/x', /segments/], ['node_modules/x/a.md', /segments/],
    ['.env', /\.env files/], ['docs/.env.local', /\.env files/],
    [`docs/a${String.fromCharCode(10)}b.md`, /control characters/], ['x'.repeat(513), /limit is 512/],
  ])('rejects %j', (p, msg) => expect(() => validateFilePath(p)).toThrow(msg));
});

describe('validateFileContent', () => {
  it('hashes the UTF-8 bytes and keeps a BOM and CRLF line endings', () => {
    const text = `${String.fromCharCode(0xfeff)}# Stav\r\nčítaj\r\n`;
    const bytes = Buffer.from(text, 'utf8');
    expect(validateFileContent(text)).toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
    });
  });

  it('accepts exactly 1 MiB and refuses one byte more with 413', () => {
    expect(validateFileContent('x'.repeat(FILE_LIMITS.contentBytes)).size).toBe(1_048_576);
    expect(thrown(() => validateFileContent('x'.repeat(FILE_LIMITS.contentBytes + 1)))).toMatchObject({
      code: 'too_large', status: 413, message: expect.stringMatching(/limit is 1048576/),
    });
  });

  it('counts bytes, not characters', () => {
    expect(() => validateFileContent('č'.repeat(FILE_LIMITS.contentBytes / 2 + 1))).toThrow(/limit is 1048576/);
  });

  it('rejects NUL characters and lone surrogates', () => {
    expect(() => validateFileContent(`a${String.fromCharCode(0)}b`)).toThrow(/NUL/);
    expect(() => validateFileContent(`a${String.fromCharCode(0xd800)}b`)).toThrow(/UTF-8/);
  });
});

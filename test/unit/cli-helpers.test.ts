import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Status = 'in-sync' | 'new' | 'changed' | 'newer-on-server' | 'conflict' | 'missing-locally' | 'deleted-on-server' | 'gone';
type CliModule = {
  VERSION: string;
  MAX_BYTES: number;
  matchesAny(path: string, patterns: string[]): boolean;
  isEnvFile(path: string): boolean;
  isSafeRelPath(path: string): boolean;
  classify(e: { local: string | null; base: string | null; server: string | null }): Status;
  checkText(bytes: Uint8Array): { ok: true; text: string } | { ok: false; reason: string };
  parseArgs(argv: string[]): { cmd: string | undefined; args: string[]; flags: Set<string> };
};

const CLI_URL = new URL('../../cli/tabula.mjs', import.meta.url);
// A non-literal specifier keeps TypeScript from looking for type declarations of the plain .mjs file.
const cli = (await import(CLI_URL.href)) as CliModule;

describe('glob matching', () => {
  it.each([
    ['docs/**', 'docs/a.md', true],
    ['docs/**', 'docs/x/y/z.md', true],
    ['docs/**', 'docsx/a.md', false],
    ['docs/**', 'docs', false],
    ['**/docs/handoff/*.md', 'docs/handoff/s.md', true],
    ['**/docs/handoff/*.md', 'series/a/docs/handoff/s.md', true],
    ['**/docs/handoff/*.md', 'docs/handoff/x/s.md', false],
    ['docs/handoff/*.md', 'docs/handoff/.hidden.md', true],
    ['.superpowers/sdd/*/progress.md', '.superpowers/sdd/plan-1/progress.md', true],
    ['.superpowers/sdd/*/progress.md', '.superpowers/sdd/a/b/progress.md', false],
    ['series/*/docs/handoff/**', 'series/station/docs/handoff/2026-10-26.md', true],
    ['a?.md', 'ab.md', true],
    ['a?.md', 'a/.md', false],
    ['docs/(x)+.md', 'docs/(x)+.md', true],
    ['docs/(x)+.md', 'docs/xx.md', false],
    ['**', 'anything/at/all.md', true],
    ['*.md', 'docs/a.md', false],
  ])('%s matches %s: %s', (glob, path, expected) => expect(cli.matchesAny(path, [glob])).toBe(expected));
});

describe('path safety', () => {
  it.each(['.env', 'docs/.env', 'a/b/.env.local', '.env.production'])('%s is an env file', (p) => expect(cli.isEnvFile(p)).toBe(true));
  it.each(['.envrc', 'env.md', 'docs/my.env'])('%s is not an env file', (p) => expect(cli.isEnvFile(p)).toBe(false));
  it.each(['docs/a.md', 'docs/plány/stav s medzerou.md'])('%s is safe', (p) => expect(cli.isSafeRelPath(p)).toBe(true));
  it.each([
    '', '/etc/passwd', 'C:/x', 'a\\b', '../a', 'a/../b', 'a//b', './a', '.git/hooks/pre-commit', 'node_modules/x',
    '.GIT/hooks/x', '.git./config', '.git /x', 'Node_Modules/x', 'a/.Git/x', 'a/.. /b',
    `a${String.fromCharCode(0)}b`,
  ])('%j is unsafe', (p) => expect(cli.isSafeRelPath(p)).toBe(false));
});

describe('classify', () => {
  it.each([
    [{ local: 'a', base: null, server: null }, 'new'],
    [{ local: 'a', base: 'a', server: null }, 'deleted-on-server'],
    [{ local: 'b', base: 'a', server: null }, 'changed'],
    [{ local: null, base: null, server: 's' }, 'missing-locally'],
    [{ local: null, base: 's', server: 's' }, 'missing-locally'],
    [{ local: null, base: 'a', server: null }, 'gone'],
    [{ local: 's', base: null, server: 's' }, 'in-sync'],
    [{ local: 'b', base: 'a', server: 'a' }, 'changed'],
    [{ local: 'a', base: 'a', server: 's' }, 'newer-on-server'],
    [{ local: 'b', base: 'a', server: 's' }, 'conflict'],
    [{ local: 'b', base: null, server: 's' }, 'conflict'],
  ] as const)('%j → %s', (entry, expected) => expect(cli.classify(entry)).toBe(expected));
});

describe('checkText', () => {
  it('keeps a BOM and CRLF so the server hashes the same bytes', () => {
    const text = `${String.fromCharCode(0xfeff)}# A\r\nčítaj\r\n`;
    expect(cli.checkText(Buffer.from(text, 'utf8'))).toEqual({ ok: true, text });
  });

  it('refuses NUL bytes, invalid UTF-8 and more than 1 MiB', () => {
    expect(cli.checkText(Buffer.from([0x61, 0x00]))).toMatchObject({ ok: false, reason: expect.stringMatching(/^binary/) });
    expect(cli.checkText(Buffer.from([0xc3, 0x28]))).toEqual({ ok: false, reason: 'not valid UTF-8' });
    expect(cli.checkText(Buffer.alloc(cli.MAX_BYTES, 0x61))).toMatchObject({ ok: true });
    expect(cli.checkText(Buffer.alloc(cli.MAX_BYTES + 1, 0x61))).toMatchObject({
      ok: false, reason: expect.stringMatching(/^larger than 1 MiB/),
    });
  });
});

describe('command line', () => {
  it('splits the command, the arguments and the flags', () => {
    expect(cli.parseArgs(['push', '--force', 'x'])).toEqual({ cmd: 'push', args: ['x'], flags: new Set(['--force']) });
  });

  it('runs only when started directly, and answers --version and unknown commands', () => {
    const file = fileURLToPath(CLI_URL);
    expect(execFileSync(process.execPath, [file, '--version'], { encoding: 'utf8' }).trim()).toBe(cli.VERSION);
    expect(() => execFileSync(process.execPath, [file, 'bogus'], { encoding: 'utf8', stdio: 'pipe' })).toThrow(/unknown command "bogus"/);
  });
});

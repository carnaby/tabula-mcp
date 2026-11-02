import { describe, expect, it } from 'vitest';
import { matchesSyncPattern } from '../../src/domain/glob.js';

type CliGlob = { matchesAny(path: string, patterns: string[]): boolean; globToRegExp(glob: string): RegExp };
// A non-literal specifier keeps TypeScript from looking for type declarations of the plain .mjs file.
const cli = (await import(new URL('../../cli/tabula.mjs', import.meta.url).href)) as CliGlob;

/** One table for both sides: the server decides what write_file accepts exactly as the CLI decides what it syncs. */
const CASES: Array<[glob: string, path: string, expected: boolean]> = [
  ['docs/**', 'docs/a.md', true],
  ['docs/**', 'docs/x/y/z.md', true],
  ['docs/**', 'docsx/a.md', false],
  ['docs/**', 'docs', false],
  ['docs/**', 'Docs/a.md', false],
  ['**/docs/handoff/*.md', 'docs/handoff/s.md', true],
  ['**/docs/handoff/*.md', 'series/a/docs/handoff/s.md', true],
  ['**/docs/handoff/*.md', 'docs/handoff/x/s.md', false],
  ['docs/handoff/*.md', 'docs/handoff/.hidden.md', true],
  ['docs/handoff/*.md', 'docs/handoff/state.txt', false],
  ['.superpowers/sdd/*/progress.md', '.superpowers/sdd/plan-1/progress.md', true],
  ['.superpowers/sdd/*/progress.md', '.superpowers/sdd/a/b/progress.md', false],
  ['series/*/docs/handoff/**', 'series/station/docs/handoff/2026-10-26.md', true],
  ['a?.md', 'ab.md', true],
  ['a?.md', 'a/.md', false],
  ['docs/(x)+.md', 'docs/(x)+.md', true],
  ['docs/(x)+.md', 'docs/xx.md', false],
  ['docs/[ab].md', 'docs/a.md', false],
  ['docs/[ab].md', 'docs/[ab].md', true],
  ['docs/a{1,2}.md', 'docs/a1.md', false],
  ['**', 'anything/at/all.md', true],
  ['*.md', 'docs/a.md', false],
  ['*.md', 'a.md', true],
  ['docs**', 'docs/a.md', false],
  ['docs**', 'docsx.md', true],
  ['docs/**/plan.md', 'docs/plan.md', true],
  ['docs/**/plan.md', 'docs/a/b/plan.md', true],
  ['docs/plány/*.md', 'docs/plány/stav s medzerou.md', true],
];

describe('sync pattern matching on the server and in the CLI', () => {
  it.each(CASES)('%s matches %s: %s', (glob, path, expected) => {
    expect(cli.matchesAny(path, [glob])).toBe(expected);
    expect(matchesSyncPattern(path, [glob])).toBe(expected);
  });

  it('agrees with the CLI for every pattern of the table against every path of the table', () => {
    const globs = [...new Set(CASES.map((c) => c[0]))];
    const paths = [...new Set(CASES.map((c) => c[1]))];
    for (const g of globs) {
      for (const p of paths) expect(matchesSyncPattern(p, [g]), `${g} vs ${p}`).toBe(cli.matchesAny(p, [g]));
    }
  });

  it('matches when any pattern of the list matches, and never with an empty list', () => {
    expect(matchesSyncPattern('docs/a.md', ['notes/**', 'docs/*.md'])).toBe(true);
    expect(matchesSyncPattern('docs/a.md', [])).toBe(false);
  });
});

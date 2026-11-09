import { describe, expect, it } from 'vitest';
import { matchesSyncPattern } from '../../src/domain/glob.js';

type CliGlob = { matchesAny(path: string, patterns: string[]): boolean; globMatch(glob: string, path: string): boolean };
// A non-literal specifier keeps TypeScript from looking for type declarations of the plain .mjs file.
const cli = (await import(new URL('../../../cli/tabula.mjs', import.meta.url).href)) as CliGlob;

/** The regex translation the CLI used up to 1.1.0: the reference for the semantics (it backtracks, so short inputs only). */
function referenceRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      const segmentStart = i === 0 || glob[i - 1] === '/';
      if (glob[i + 1] === '*' && segmentStart && (i + 2 === glob.length || glob[i + 2] === '/')) {
        if (i + 2 === glob.length) re += '.*';
        else {
          re += '(?:.*/)?';
          i++;
        }
        i++;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** A small deterministic generator, so a failure names a reproducible case. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const elapsed = (fn: () => unknown): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('glob matching without backtracking', () => {
  it.each([
    ['docs/*-*-*-*.md', `docs/${'-'.repeat(505)}`],
    ['*a*a*a*a*a*a*a*ab', 'a'.repeat(512)],
    ['*a*a*a*a*a*a*a*ab', 'a'.repeat(60)],
    [`${'**/'.repeat(40)}x`, `${'a/'.repeat(250)}y`],
    [`${'**/a/'.repeat(30)}b`, `${'a/'.repeat(250)}c`],
    [`${'*/'.repeat(20)}**/*?*?*?*.md`, `${'ab/'.repeat(160)}${'?'.repeat(30)}`],
  ])('%s against a long path stays fast', (glob, path) => {
    cli.matchesAny(path, [glob]); // warm-up
    expect(elapsed(() => cli.matchesAny(path, [glob]))).toBeLessThan(50);
    expect(elapsed(() => matchesSyncPattern(path, [glob]))).toBeLessThan(50);
  });

  it('decides exactly like the former regex translation on random patterns and paths', () => {
    const next = rng(20261102);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
    const globParts = ['a', 'b', '.', '-', '*', '**', '?', '/', '/', '**/', ' ', '[', '\\'];
    const pathParts = ['a', 'b', '.', '-', '/', '/', 'ab', ' ', '\n', '*', '?', '[', '\\', '\u{1F600}'];
    for (let n = 0; n < 20_000; n++) {
      const glob = Array.from({ length: 1 + Math.floor(next() * 7) }, () => pick(globParts)).join('');
      const path = Array.from({ length: Math.floor(next() * 9) }, () => pick(pathParts)).join('');
      const expected = referenceRegExp(glob).test(path);
      if (cli.globMatch(glob, path) !== expected) expect({ glob, path, match: cli.globMatch(glob, path) }).toEqual({ glob, path, match: expected });
    }
  });
});

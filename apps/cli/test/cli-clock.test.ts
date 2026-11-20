import { describe, expect, it } from 'vitest';

type CliClock = { VERSION: string; formatClock(ms: number): string };

// A non-literal specifier keeps TypeScript from looking for type declarations of the plain .mjs file.
const cli = (await import(new URL('../tabula.mjs', import.meta.url).href)) as CliClock;

describe('what the server imports from the CLI', () => {
  it('is version 1.6.0', () => {
    expect(cli.VERSION).toBe('1.6.0');
  });

  it('formats clock times like the UI', () => {
    expect([0, 5_400, 161_999, 3_723_000].map(cli.formatClock)).toEqual(['0:00', '0:05', '2:41', '1:02:03']);
  });
});

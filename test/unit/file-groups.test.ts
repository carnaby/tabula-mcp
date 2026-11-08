import { describe, expect, it } from 'vitest';
import { fileGroupKey, groupFiles } from '../../src/shared/file-groups.js';

const f = (path: string, updatedAt: string) => ({ path, updatedAt });

describe('fileGroupKey', () => {
  it('takes the first two segments of the directory', () => {
    expect(fileGroupKey('docs/plans/a.md')).toBe('docs/plans');
    expect(fileGroupKey('docs/plans/sub/deep/a.md')).toBe('docs/plans');
    expect(fileGroupKey('docs/a.md')).toBe('docs');
    expect(fileGroupKey('notes.md')).toBe('/');
  });

  it('puts everything under .superpowers into one group', () => {
    expect(fileGroupKey('.superpowers/sdd/2026-11-05-x/brief.md')).toBe('.superpowers');
    expect(fileGroupKey('.superpowers/a.md')).toBe('.superpowers');
    expect(fileGroupKey('.superpowersx/a.md')).toBe('.superpowersx');
  });

  it('treats only a top-level .superpowers folder as the work folder', () => {
    expect(fileGroupKey('docs/.superpowers/x.md')).toBe('docs/.superpowers');
    expect(fileGroupKey('.superpowers')).toBe('/');
  });
});

describe('groupFiles', () => {
  it('orders groups by their newest change, files newest first, the work folder last', () => {
    const groups = groupFiles([
      f('docs/plans/old.md', '2026-11-01T10:00:00.000Z'),
      f('.superpowers/sdd/x/progress.md', '2026-11-05T12:00:00.000Z'),
      f('docs/handoff/state.md', '2026-11-04T09:00:00.000Z'),
      f('docs/plans/sub/deep/new.md', '2026-11-03T08:00:00.000Z'),
      f('README.local.md', '2026-10-01T00:00:00.000Z'),
      f('docs/index.md', '2026-11-02T00:00:00.000Z'),
    ]);
    expect(groups.map((g) => [g.key, g.files.map((x) => x.name)])).toEqual([
      ['docs/handoff', ['state.md']],
      ['docs/plans', ['sub/deep/new.md', 'old.md']],
      ['docs', ['index.md']],
      ['/', ['README.local.md']],
      ['.superpowers', ['sdd/x/progress.md']],
    ]);
    expect(groups.map((g) => g.work)).toEqual([false, false, false, false, true]);
    expect(groups[1]!.latest).toBe('2026-11-03T08:00:00.000Z');
  });

  it('names root files by their full path and the work folder only for a top-level .superpowers', () => {
    const groups = groupFiles([f('.superpowers', '2026-11-05T00:00:00.000Z'), f('docs/.superpowers/x.md', '2026-11-04T00:00:00.000Z')]);
    expect(groups.map((g) => [g.key, g.work, g.files.map((x) => x.name)])).toEqual([
      ['/', false, ['.superpowers']],
      ['docs/.superpowers', false, ['x.md']],
    ]);
  });

  it('breaks ties on equal timestamps by name (files) and by folder (groups)', () => {
    const t = '2026-11-05T10:00:00.000Z';
    const groups = groupFiles([f('docs/b/z.md', t), f('docs/b/a.md', t), f('docs/a/m.md', t), f('root.md', t)]);
    expect(groups.map((g) => [g.key, g.files.map((x) => x.name)])).toEqual([
      ['/', ['root.md']],
      ['docs/a', ['m.md']],
      ['docs/b', ['a.md', 'z.md']],
    ]);
  });

  it('breaks ties by plain code-unit order, independent of the locale', () => {
    const t = '2026-11-05T10:00:00.000Z';
    const groups = groupFiles([f('docs/a.md', t), f('docs/B.md', t), f('b/x.md', t), f('A/x.md', t)]);
    expect(groups.map((g) => g.key)).toEqual(['A', 'b', 'docs']);
    expect(groups[2]!.files.map((x) => x.name)).toEqual(['B.md', 'a.md']);
  });

  it('returns no groups for no files', () => {
    expect(groupFiles([])).toEqual([]);
  });
});

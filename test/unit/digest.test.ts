import { describe, expect, it } from 'vitest';
import {
  buildDigest, type DigestFile, type DigestInput, type DigestMemory, firstSentence, formatSize,
} from '../../src/domain/digest.js';
import { DIGEST_BUDGET, estimateTokens } from '../../src/domain/tokens.js';

const id = (n: number) => `${n.toString(16).padStart(4, '0')}0000-0000-4000-8000-000000000000`;
const day = (d: number) => new Date(Date.UTC(2026, 9, d));
const mem = (n: number, kind: DigestMemory['kind'], title: string, body: string, d: number): DigestMemory =>
  ({ id: id(n), kind, title, body, updatedAt: day(d) });
const file = (path: string, size: number, d: number, isState = false): DigestFile => ({ path, size, updatedAt: day(d), isState });

const fixture: DigestInput = {
  project: 'acme',
  date: '2026-10-26',
  memories: [
    mem(1, 'rule', 'Never give an agent raw shell access.', 'Expose domain-scoped tools only.', 1),
    mem(2, 'rule', 'Run long jobs detached.', 'Background tasks die with the session. Use a log file.', 10),
    mem(3, 'gotcha', 'Tools turn a NUL escape into a real NUL byte.', 'Use a regex instead.', 5),
    mem(4, 'fact', 'Production runs on a single host', 'Not in a managed cloud.', 3),
    mem(5, 'decision', 'Drizzle over Prisma', 'Typed schema.', 4),
  ],
  files: [file('docs/specs/design.md', 12_800, 20), file('docs/handoff/state.md', 300, 25, true)],
  state: [{ path: 'docs/handoff/state.md', content: '# State\nNext: write the CLI.\n', updatedAt: day(25) }],
};

const FULL = [
  '# Tabula · acme · 2026-10-26',
  '',
  '## Global rules (always follow)',
  '- Run long jobs detached. (#0002)',
  '  Background tasks die with the session. Use a log file.',
  '- Never give an agent raw shell access. (#0001)',
  '  Expose domain-scoped tools only.',
  '',
  '## Global gotchas',
  '- Tools turn a NUL escape into a real NUL byte. (#0003)',
  '  Use a regex instead.',
  '',
  '## Global facts and decisions (title only — `get` for the why)',
  '- Drizzle over Prisma (#0005)',
  '- Production runs on a single host (#0004)',
  '',
  '## Project state',
  '### docs/handoff/state.md (2026-10-25)',
  '# State',
  'Next: write the CLI.',
  '',
  '## Files (2) — `read_file` for the content',
  'docs/handoff/ — state.md (10-25, 300 B, state)',
  'docs/specs/ — design.md (10-20, 12.5 KB)',
  '',
].join('\n');

describe('buildDigest', () => {
  it('renders the global rules, the project state and the files in a fixed order', () => {
    const d = buildDigest(fixture);
    expect(d.text).toBe(FULL);
    expect(d).toMatchObject({ tokens: estimateTokens(FULL), trimmed: [], overBudget: false });
  });

  it('leaves the state out when it is not asked for, but still marks state files', () => {
    const d = buildDigest({ ...fixture, state: undefined });
    expect(d.text).not.toContain('## Project state');
    expect(d.text).toContain('docs/handoff/ — state.md (10-25, 300 B, state)');
  });

  it('explains an empty digest', () => {
    expect(buildDigest({ project: 'demo', date: '2026-10-26', memories: [], files: [] }).text).toBe(
      '# Tabula · demo · 2026-10-26\n\nNo global rules and no synced files yet. Files appear here after `tabula push` in a repository with a `.tabula.json`.\n',
    );
  });

  it('truncates a long state at a line break with a pointer to read_file, keeping the rules and the files', () => {
    const long = Array.from({ length: 600 }, (_, i) => `Line ${i} of the handoff state.`).join('\n');
    const d = buildDigest({ ...fixture, state: [{ path: 'docs/handoff/state.md', content: long, updatedAt: day(25) }] });
    expect(d.trimmed).toEqual(['state-truncated']);
    expect(d.overBudget).toBe(false);
    expect(d.tokens).toBeLessThanOrEqual(DIGEST_BUDGET);
    expect(d.text).toContain('Background tasks die with the session. Use a log file.');
    expect(d.text).toMatch(/Line \d+ of the handoff state\.\n\[… truncated — read_file\("docs\/handoff\/state\.md"\) for the rest\]/);
    expect(d.text).toContain('## Files (2)');
  });

  it('replaces a state file that no longer fits with a pointer and stays within the budget', () => {
    const d = buildDigest({
      ...fixture,
      state: [
        { path: 'docs/handoff/a.md', content: 'a'.repeat(20_000), updatedAt: day(26) },
        { path: 'docs/handoff/b.md', content: 'b'.repeat(500), updatedAt: day(20) },
      ],
    });
    expect(d.text).toContain('[… truncated — read_file("docs/handoff/a.md") for the rest]');
    expect(d.text).toContain('### docs/handoff/b.md (2026-10-20)\n[omitted to fit the budget — read_file("docs/handoff/b.md")]');
    expect(d.overBudget).toBe(false);
  });

  it('trims the file list and the rules in a fixed order when they alone exceed the budget', () => {
    const d = buildDigest({ ...fixture, budget: 1 });
    expect(d.trimmed).toEqual([
      'files-collapsed', 'facts-omitted', 'gotchas-first-sentence', 'rules-first-sentence', 'state-truncated',
    ]);
    expect(d.text).toContain('- 2 synced files — call `list_files` for the list');
    expect(d.text).toContain('## Global facts and decisions\n- 2 omitted — use search');
    expect(d.text).toContain('  Background tasks die with the session.\n');
    expect(d.text).not.toContain('Use a log file.');
    expect(d.text).toContain('[omitted to fit the budget — read_file("docs/handoff/state.md")]');
    expect(d.overBudget).toBe(true);
    expect(d.text.split('\n\n')[1]).toMatch(/^\(Over budget: ~\d+ tokens of 1 after all trimming\./);
  });

  it('collapses the file list instead of overflowing when the list leaves no room for the state', () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`docs/specs/${'long-name-'.repeat(8)}${i}.md`, 1000, 20));
    files.push(file('docs/handoff/state.md', 300, 25, true));
    const input: DigestInput = { project: 'acme', date: '2026-10-26', memories: [], files, state: fixture.state };
    // A budget the list alone fits in, but not together with the state.
    const budget = estimateTokens(buildDigest({ ...input, state: undefined }).text) + 5;
    expect(buildDigest({ ...input, state: undefined, budget }).trimmed).toEqual([]);
    const d = buildDigest({ ...input, budget });
    expect(d.overBudget).toBe(false);
    expect(d.tokens).toBeLessThanOrEqual(budget);
    expect(d.trimmed).toContain('files-collapsed');
    expect(d.text).toContain('## Project state\n### docs/handoff/state.md (2026-10-25)\n# State\nNext: write the CLI.');
    expect(d.text).not.toContain('[omitted to fit the budget');
  });

  it('applies only the steps it needs', () => {
    const d = buildDigest({ ...fixture, budget: 160 });
    expect(d.trimmed).toEqual(['files-collapsed']);
    expect(d.overBudget).toBe(false);
    expect(d.text).toContain('Background tasks die with the session. Use a log file.');
    expect(d.text).toContain('## Project state\n### docs/handoff/state.md (2026-10-25)\n# State\nNext: write the CLI.');
  });

  it('states the size of the final text, warning included, when over budget', () => {
    const d = buildDigest({ ...fixture, budget: 1 });
    const n = /\(Over budget: ~(\d+) tokens of 1 /.exec(d.text)?.[1];
    expect(Number(n)).toBe(d.tokens);
    expect(d.tokens).toBe(estimateTokens(d.text));
  });

  it('extends short ids when two rules share a 4-character prefix', () => {
    const a = { ...fixture.memories[0]!, id: 'abcd1000-0000-4000-8000-000000000000' };
    const b = { ...fixture.memories[0]!, id: 'abcd2000-0000-4000-8000-000000000000', title: 'Other rule' };
    const d = buildDigest({ project: 'acme', date: '2026-10-26', memories: [a, b], files: [] });
    expect(d.text).toContain('(#abcd1)');
    expect(d.text).toContain('(#abcd2)');
  });
});

describe('the file list', () => {
  const at = (d: number, h = 0) => new Date(Date.UTC(2026, 10, d, h));
  const f = (path: string, d: number, h = 0, isState = false): DigestFile => ({ path, size: 2048, updatedAt: at(d, h), isState });
  const section = (files: DigestFile[]) =>
    buildDigest({ project: 'acme', date: '2026-11-05', memories: [], files }).text.split('\n\n')[1]!.trimEnd();

  it('shows the 10 newest files grouped by folder, newest group first, the work folder last, and counts the rest', () => {
    const files = [
      f('.superpowers/sdd/x/progress.md', 5, 10),
      f('docs/plans/2026-11-05-bell.md', 5, 9),
      f('docs/handoff/state.md', 5, 8, true),
      f('docs/demo/people.md', 5, 7),
      f('docs/plans/2026-11-04-live.md', 4),
      f('README.local.md', 3),
      ...Array.from({ length: 12 }, (_, i) => f(`docs/plans/old-${i}.md`, 1, i)),
      ...Array.from({ length: 6 }, (_, i) => f(`docs/specs/s-${i}.md`, 0)),
    ];
    expect(section(files)).toBe([
      '## Files (24) — 10 newest; `read_file` for the content',
      'docs/plans/ — 2026-11-05-bell.md (11-05, 2.0 KB), 2026-11-04-live.md (11-04, 2.0 KB), old-11.md (11-01, 2.0 KB), old-10.md (11-01, 2.0 KB), old-9.md (11-01, 2.0 KB), old-8.md (11-01, 2.0 KB)',
      'docs/handoff/ — state.md (11-05, 2.0 KB, state)',
      'docs/demo/ — people.md (11-05, 2.0 KB)',
      '/ — README.local.md (11-03, 2.0 KB)',
      '.superpowers/ — sdd/x/progress.md (11-05, 2.0 KB)',
      '- 14 more — `list_files`',
    ].join('\n'));
  });

  it('picks the newest files by path when their times are equal', () => {
    const files = Array.from({ length: 12 }, (_, i) => f(`docs/x/${String.fromCharCode(108 - i)}.md`, 5)); // l.md ... a.md
    expect(section(files)).toBe([
      '## Files (12) — 10 newest; `read_file` for the content',
      `docs/x/ — ${'abcdefghij'.split('').map((c) => `${c}.md (11-05, 2.0 KB)`).join(', ')}`,
      '- 2 more — `list_files`',
    ].join('\n'));
  });

  it('lists every file without a count when there are at most 10', () => {
    const s = section(Array.from({ length: 10 }, (_, i) => f(`n${i}.md`, 5, i)));
    expect(s.split('\n')).toEqual([
      '## Files (10) — `read_file` for the content',
      `/ — ${Array.from({ length: 10 }, (_, i) => `n${9 - i}.md (11-05, 2.0 KB)`).join(', ')}`,
    ]);
  });

  it('never contains references', () => {
    expect(section([f('docs/a.md', 5)])).not.toContain('tabula:');
  });
});

describe('formatSize', () => {
  it('uses B, KB and MB with one decimal', () => {
    expect([0, 1023, 1024, 12_800, 1_048_576].map(formatSize)).toEqual(['0 B', '1023 B', '1.0 KB', '12.5 KB', '1.0 MB']);
  });
});

describe('firstSentence', () => {
  it('cuts at the first sentence end', () => expect(firstSentence('One. Two.')).toBe('One.'));
  it('keeps text without terminator', () => expect(firstSentence('no end here')).toBe('no end here'));
  it('flattens whitespace', () => expect(firstSentence('A\n  b! c')).toBe('A b!'));
});

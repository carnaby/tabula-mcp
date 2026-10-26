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
  '- docs/handoff/state.md — 2026-10-25, 300 B (state)',
  '- docs/specs/design.md — 2026-10-20, 12.5 KB',
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
    expect(d.text).toContain('- docs/handoff/state.md — 2026-10-25, 300 B (state)');
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

  it('extends short ids when two rules share a 4-character prefix', () => {
    const a = { ...fixture.memories[0]!, id: 'abcd1000-0000-4000-8000-000000000000' };
    const b = { ...fixture.memories[0]!, id: 'abcd2000-0000-4000-8000-000000000000', title: 'Other rule' };
    const d = buildDigest({ project: 'acme', date: '2026-10-26', memories: [a, b], files: [] });
    expect(d.text).toContain('(#abcd1)');
    expect(d.text).toContain('(#abcd2)');
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

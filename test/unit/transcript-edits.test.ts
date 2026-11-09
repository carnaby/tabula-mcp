import { describe, expect, it } from 'vitest';
import type { Diarization, TranscriptSegment } from '../../src/db/schema.js';
import {
  AGENT_EDITS_MAX, allowedSpeakers, applyAgentEdits, checkAgentEdits, editedLine, restoredLine,
} from '../../src/domain/transcript-edits.js';

const NOW = new Date('2026-11-09T10:00:00.000Z');
const LINES: TranscriptSegment[] = [
  { start_ms: 12_000, end_ms: 12_400, text: 'Otvor Tablu.', speaker: 'S1' },
  { start_ms: 12_500, end_ms: 13_900, text: 'Ktorú tablu?', speaker: 'S2' },
  { start_ms: 16_000, end_ms: 17_000, text: 'Tú v projekte Vít.', speaker: 'S1' },
];
const PYANNOTE: Diarization = { model: 'pyannote/speaker-diarization-community-1', speakers: 2 };
const run = (edits: Parameters<typeof checkAgentEdits>[0], lines = LINES) => applyAgentEdits(lines, PYANNOTE, checkAgentEdits(edits), NOW);

describe('line edits', () => {
  it('knows the speakers a line may get', () => {
    expect(allowedSpeakers(PYANNOTE)).toEqual(['S1', 'S2']);
    expect(allowedSpeakers({ error: 'CUDA is not available' })).toEqual([]);
    expect(allowedSpeakers(null)).toEqual([]);
  });

  it("keeps the worker's line from the first edit and restores it", () => {
    const once = editedLine(LINES[0]!, { text: 'Otvor Tabulu.' }, 'agent', NOW);
    const twice = editedLine(once, { speaker: 'S2' }, 'user', new Date('2026-11-09T11:00:00.000Z'));
    expect(twice).toEqual({
      start_ms: 12_000, end_ms: 12_400, text: 'Otvor Tabulu.', speaker: 'S2',
      edit: { by: 'user', at: '2026-11-09T11:00:00.000Z', original: { text: 'Otvor Tablu.', speaker: 'S1' } },
    });
    expect(restoredLine(twice)).toEqual(LINES[0]);
    expect(restoredLine(LINES[1]!)).toBe(LINES[1]);
    const unlabeled = editedLine({ start_ms: 0, end_ms: 1, text: 'a' }, { text: 'b' }, 'user', NOW);
    expect(unlabeled.edit!.original).toEqual({ text: 'a' });
    expect(restoredLine(unlabeled)).toEqual({ start_ms: 0, end_ms: 1, text: 'a' });
  });
});

describe('edit_transcript rules', () => {
  it('replaces the first exact occurrence of from, and changes the speaker', () => {
    const r = run([{ at: '0:16', from: 'Vít', to: 'Vite' }, { at: '0:16', speaker: 'S2' }]);
    expect(r.written).toEqual([{ at: '0:16', text: 'Tú v projekte Vite.' }, { at: '0:16', speaker: 'S2' }]);
    expect(r.skipped).toEqual([]);
    expect(r.segments[2]).toEqual({
      start_ms: 16_000, end_ms: 17_000, text: 'Tú v projekte Vite.', speaker: 'S2',
      edit: { by: 'agent', at: NOW.toISOString(), original: { text: 'Tú v projekte Vít.', speaker: 'S1' } },
    });
    expect(run([{ at: '0:16', from: 'e', to: 'E' }]).written).toEqual([{ at: '0:16', text: 'Tú v projEkte Vít.' }]);
  });

  it('picks the line of an ambiguous second by from, and skips when from does not decide', () => {
    const r = run([{ at: '0:12', from: 'Tablu', to: 'Tabulu' }]);
    expect(r.written).toEqual([{ at: '0:12', text: 'Otvor Tabulu.' }]);
    expect(r.segments[1]).toEqual(LINES[1]);
    expect(run([{ at: '0:12', from: 'u', to: 'U' }]).skipped).toEqual([{ at: '0:12', reason: '2 lines at 0:12 contain "u"; pass a longer from' }]);
    expect(run([{ at: '0:12', speaker: 'S2' }]).skipped).toEqual([{ at: '0:12', reason: '2 lines start at 0:12; pass from to pick one' }]);
    expect(run([{ at: '0:12', from: 'Tabula', to: 'x' }]).skipped).toEqual([{ at: '0:12', reason: 'no line at 0:12 contains "Tabula"' }]);
  });

  it("skips the user's line, a missing line, a missing from, an unknown speaker and an empty result", () => {
    const userLine = editedLine(LINES[2]!, { text: 'Tú v projekte Vite.' }, 'user', NOW);
    const r = run(
      [{ at: '0:16', from: 'Vite', to: 'Vít' }, { at: '0:20', from: 'a', to: 'b' }, { at: '1:00:00', speaker: 'S1' }],
      [LINES[0]!, LINES[1]!, userLine],
    );
    expect(r.written).toEqual([]);
    expect(r.skipped).toEqual([
      { at: '0:16', reason: 'the user edited this line; a line the user edited is never changed' },
      { at: '0:20', reason: 'no line starts at 0:20' },
      { at: '1:00:00', reason: 'no line starts at 1:00:00' },
    ]);
    const more = run([
      { at: '0:16', from: 'Z', to: 'Y' },
      { at: '0:16', speaker: 'S7' },
      { at: '0:16', from: 'Tú v projekte Vít.', to: '  ' },
      { at: '0:16', from: 'Vít', to: 'x'.repeat(2000) },
    ]);
    expect(more.skipped).toEqual([
      { at: '0:16', reason: '"Z" is not in the line' },
      { at: '0:16', reason: 'unknown speaker S7; the recording has S1, S2' },
      { at: '0:16', reason: 'the line would be empty' },
      { at: '0:16', reason: 'the line would be 2015 characters; the limit is 2000' },
    ]);
    expect(more.segments).toEqual(LINES);
  });

  it('edits a line again that an agent edited before', () => {
    const first = run([{ at: '0:16', from: 'Vít', to: 'Víte' }]);
    const second = applyAgentEdits(first.segments, PYANNOTE, checkAgentEdits([{ at: '0:16', from: 'Víte', to: 'Vite' }]), NOW);
    expect(second.written).toEqual([{ at: '0:16', text: 'Tú v projekte Vite.' }]);
    expect(second.segments[2]!.edit!.original).toEqual({ text: 'Tú v projekte Vít.', speaker: 'S1' });
  });

  it('refuses a malformed call before anything is read', () => {
    const one = { at: '0:16', speaker: 'S1' };
    expect(checkAgentEdits(Array(AGENT_EDITS_MAX).fill(one))).toHaveLength(50);
    expect(() => checkAgentEdits(Array(51).fill(one))).toThrow(/51 edits; at most 50 in one call/);
    expect(() => checkAgentEdits([])).toThrow(/edits is empty/);
    expect(() => checkAgentEdits([{ at: '0:16', from: 'Vít' }])).toThrow(/edit 1: pass from and to together/);
    expect(() => checkAgentEdits([{ at: '0:16', to: 'Vít' }])).toThrow(/edit 1: pass from and to together/);
    expect(() => checkAgentEdits([{ at: '0:16' }])).toThrow(/edit 1: pass from and to, speaker, or both/);
    expect(() => checkAgentEdits([{ at: '0:16', from: '', to: 'x' }])).toThrow(/edit 1: from is empty/);
    expect(() => checkAgentEdits([{ at: '0:16', speaker: 'S1' }, { at: 'soon', speaker: 'S1' }])).toThrow(/edit 2: at "soon" must be seconds/);
    expect(() => checkAgentEdits([one, { at: 'noon', speaker: 'S1' }])).toThrow(/at "noon"/);
    expect(() => checkAgentEdits([{ at: '0:16', from: 'Vít', to: `a${String.fromCharCode(0)}` }])).toThrow(/NUL/);
  });
});

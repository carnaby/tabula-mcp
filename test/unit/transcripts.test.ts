import { describe, expect, it } from 'vitest';
import { cleanSegments, clock, sliceLines, TRANSCRIPT_LIMITS, transcriptLines, transcriptText } from '../../src/domain/transcripts.js';

describe('transcript helpers', () => {
  it('formats clock times like the UI', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(5_400)).toBe('0:05');
    expect(clock(161_999)).toBe('2:41');
    expect(clock(3_723_000)).toBe('1:02:03');
    expect(clock(-5)).toBe('0:00');
  });

  it('cleans segments: whole milliseconds, collapsed whitespace, no empty ones, in time order', () => {
    expect(
      cleanSegments([
        { start_ms: 161000.4, end_ms: 163000, text: ' Tu sa\n tlačidlo  zasekne. ' },
        { start_ms: 0, end_ms: 1500.6, text: 'Ahoj.' },
        { start_ms: 2000, end_ms: 2500, text: '   ' },
      ]),
    ).toEqual([
      { start_ms: 0, end_ms: 1501, text: 'Ahoj.' },
      { start_ms: 161000, end_ms: 163000, text: 'Tu sa tlačidlo zasekne.' },
    ]);
  });

  it.each([
    ['a negative start', { start_ms: -1, end_ms: 5, text: 'x' }],
    ['an end before the start', { start_ms: 10, end_ms: 5, text: 'x' }],
    ['a time past 24 hours', { start_ms: 0, end_ms: 25 * 3600 * 1000, text: 'x' }],
    ['a time that is not a number', { start_ms: Number.NaN, end_ms: 5, text: 'x' }],
    ['an overlong segment', { start_ms: 0, end_ms: 5, text: 'x'.repeat(2001) }],
    ['a NUL character', { start_ms: 0, end_ms: 5, text: `a${String.fromCharCode(0)}b` }],
  ])('refuses %s', (_what, segment) => {
    expect(() => cleanSegments([segment])).toThrow();
  });

  it('refuses too many segments and too much text', () => {
    const one = { start_ms: 0, end_ms: 1, text: 'x' };
    expect(() => cleanSegments(Array.from({ length: TRANSCRIPT_LIMITS.segments + 1 }, () => one))).toThrow(/segments/);
    const long = { start_ms: 0, end_ms: 1, text: 'y'.repeat(2000) };
    expect(() => cleanSegments(Array.from({ length: 251 }, () => long))).toThrow(/longer than/);
  });

  it('renders lines for agents and plain text for search', () => {
    const s = [
      { start_ms: 0, end_ms: 900, text: 'Ahoj.' },
      { start_ms: 161_000, end_ms: 163_000, text: 'Tu sa zasekne.' },
    ];
    expect(transcriptLines(s)).toBe('[0:00] Ahoj.\n[2:41] Tu sa zasekne.');
    expect(transcriptText(s)).toBe('Ahoj.\nTu sa zasekne.');
    expect(transcriptLines([])).toBe('');
  });

  it('slices at line breaks and names the next offset', () => {
    const text = ['[0:00] aaaa', '[0:05] bbbb', '[0:10] cccc'].join('\n');
    expect(sliceLines(text, 0, 100)).toEqual({ text, next: null });
    expect(sliceLines(text, 0, 20)).toEqual({ text: '[0:00] aaaa', next: 12 });
    expect(sliceLines(text, 12, 20)).toEqual({ text: '[0:05] bbbb', next: 24 });
    expect(sliceLines(text, 24, 20)).toEqual({ text: '[0:10] cccc', next: null });
    expect(sliceLines(text, 99, 20)).toEqual({ text: '', next: null });
  });

  it('keeps the speaker of a segment and refuses one that is not S1 … S99', () => {
    expect(cleanSegments([{ start_ms: 0, end_ms: 900, text: 'Kde je tlačidlo?', speaker: 'S1' }])).toEqual([
      { start_ms: 0, end_ms: 900, text: 'Kde je tlačidlo?', speaker: 'S1' },
    ]);
    expect(() => cleanSegments([{ start_ms: 0, end_ms: 900, text: 'x', speaker: 'Speaker 1' }])).toThrow(/segment 0: speaker/);
    for (const bad of [['S1'], 1, true, {}, '']) {
      expect(() => cleanSegments([{ start_ms: 0, end_ms: 900, text: 'x', speaker: bad as never }])).toThrow(/segment 0: speaker/);
    }
  });

  it('treats a null or missing speaker as no label', () => {
    const out = cleanSegments([
      { start_ms: 0, end_ms: 500, text: 'a', speaker: null as never },
      { start_ms: 500, end_ms: 900, text: 'b', speaker: undefined },
    ]);
    expect(out).toEqual([{ start_ms: 0, end_ms: 500, text: 'a' }, { start_ms: 500, end_ms: 900, text: 'b' }]);
    expect(out.every((s) => !('speaker' in s))).toBe(true);
  });

  it('writes the speaker before the text when labels are given', () => {
    const segments = [
      { start_ms: 12_000, end_ms: 15_000, text: 'Kde je tlačidlo?', speaker: 'S1' },
      { start_ms: 16_000, end_ms: 17_000, text: 'Vpravo hore.', speaker: 'S2' },
    ];
    expect(transcriptLines(segments, { S1: 'Eva', S2: 'S2' })).toBe('[0:12] Eva: Kde je tlačidlo?\n[0:16] S2: Vpravo hore.');
    expect(transcriptLines(segments)).toBe('[0:12] Kde je tlačidlo?\n[0:16] Vpravo hore.');
  });
});

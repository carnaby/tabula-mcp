import { describe, expect, it } from 'vitest';

type Word = { start_ms: number; end_ms: number; text: string };
type Seg = { start_ms: number; end_ms: number; text: string; words?: Word[]; speaker?: string };
type Turn = { start_ms: number; end_ms: number; speaker: string };
type Cli = {
  assignSpeakers(segments: Seg[], turns: Turn[]): { segments: Seg[]; speakers: number };
  withoutWords(segments: Seg[]): Seg[];
  normalizeTranscript(raw: unknown): { segments: Seg[] };
  normalizeDiarization(raw: unknown): { model: string; turns: Turn[] };
  whisperPrompt(setting: unknown, project: string): string | null;
  diarizeSettings(value: unknown): { python: string[]; script: string } | null;
  DIARIZE_MODEL: string;
};
// A non-literal specifier keeps TypeScript from looking for type declarations of the plain .mjs file.
const cli = (await import(new URL('../tabula.mjs', import.meta.url).href)) as Cli;

const w = (start: number, end: number, text: string): Word => ({ start_ms: start, end_ms: end, text });
const t = (start: number, end: number, speaker: string): Turn => ({ start_ms: start, end_ms: end, speaker });
const seg = (words: Word[], text = words.map((x) => x.text).join(' ')): Seg => ({ start_ms: words[0]!.start_ms, end_ms: words.at(-1)!.end_ms, text, words });

describe('assignSpeakers', () => {
  it('splits a segment where the speaker changes in the middle of a sentence', () => {
    const segments = [seg([w(0, 300, 'Kde'), w(300, 500, 'je'), w(500, 700, 'to'), w(700, 1400, 'tlačidlo?'), w(1600, 2200, 'Vpravo'), w(2200, 3000, 'hore.')])];
    expect(cli.assignSpeakers(segments, [t(0, 1500, 'SPEAKER_00'), t(1500, 3100, 'SPEAKER_01')])).toEqual({
      speakers: 2,
      segments: [
        { start_ms: 0, end_ms: 1400, text: 'Kde je to tlačidlo?', speaker: 'S1' },
        { start_ms: 1600, end_ms: 3000, text: 'Vpravo hore.', speaker: 'S2' },
      ],
    });
  });

  it("keeps Whisper's text and times when one speaker says the whole segment", () => {
    const segments = [{ ...seg([w(100, 400, 'Ahoj,'), w(400, 900, 'test.')]), start_ms: 0, end_ms: 1000, text: 'Ahoj, test.' }];
    expect(cli.assignSpeakers(segments, [t(0, 5000, 'A')])).toEqual({ speakers: 1, segments: [{ start_ms: 0, end_ms: 1000, text: 'Ahoj, test.', speaker: 'S1' }] });
  });

  it("gives a word outside every turn the nearest speaker within a second, else the previous word's", () => {
    const segments = [seg([w(0, 500, 'a'), w(1200, 1400, 'b'), w(2500, 2700, 'c'), w(5800, 6000, 'd')])];
    // b: A ends 200 ms before it. c: A is 1.5 s away, B 2.3 s: both too far, so the previous word's A. d: B is 300 ms away.
    expect(cli.assignSpeakers(segments, [t(0, 1000, 'A'), t(5000, 5500, 'B')]).segments).toEqual([
      { start_ms: 0, end_ms: 2700, text: 'a b c', speaker: 'S1' },
      { start_ms: 5800, end_ms: 6000, text: 'd', speaker: 'S2' },
    ]);
    // The first word has no previous one: the nearest turn, however far.
    expect(cli.assignSpeakers([seg([w(9000, 9100, 'x')])], [t(0, 1000, 'A'), t(5000, 6000, 'B')]).segments).toEqual([{ start_ms: 9000, end_ms: 9100, text: 'x', speaker: 'S1' }]);
  });

  it('gives a segment without words the speaker who overlaps it most, and a word without length the turn it sits in', () => {
    expect(cli.assignSpeakers([{ start_ms: 0, end_ms: 2000, text: 'Áno.' }], [t(0, 600, 'A'), t(600, 2000, 'B')])).toEqual({
      speakers: 1, segments: [{ start_ms: 0, end_ms: 2000, text: 'Áno.', speaker: 'S1' }],
    });
    const hm = cli.assignSpeakers([seg([w(0, 300, 'Tak'), w(500, 500, 'hm')])], [t(0, 400, 'A'), t(450, 900, 'B')]);
    expect(hm.segments.map((s) => [s.text, s.speaker])).toEqual([['Tak', 'S1'], ['hm', 'S2']]);
  });

  it('leaves the segments without speakers when no turn was found', () => {
    expect(cli.assignSpeakers([seg([w(0, 900, 'Ahoj.')])], [])).toEqual({ speakers: 0, segments: [{ start_ms: 0, end_ms: 900, text: 'Ahoj.' }] });
  });

  it('numbers the speakers who speak, without gaps', () => {
    // pyannote heard a cough as a third speaker; nobody's words fall into it.
    const turns = [t(5000, 6000, 'Y'), t(0, 1000, 'X'), t(1000, 1100, 'COUGH')];
    const r = cli.assignSpeakers([seg([w(0, 1000, 'Ahoj.')]), seg([w(5000, 6000, 'Čau.')])], turns);
    expect(r).toEqual({ speakers: 2, segments: [{ start_ms: 0, end_ms: 1000, text: 'Ahoj.', speaker: 'S1' }, { start_ms: 5000, end_ms: 6000, text: 'Čau.', speaker: 'S2' }] });
  });

  it('refuses more than 99 speakers', () => {
    const segments = Array.from({ length: 100 }, (_, i) => seg([w(i * 1000, i * 1000 + 500, `w${i}`)]));
    const turns = Array.from({ length: 100 }, (_, i) => t(i * 1000, i * 1000 + 500, `P${i}`));
    expect(() => cli.assignSpeakers(segments, turns)).toThrow(/more than 99 speakers/);
  });

  it('joins a two-hour recording quickly', () => {
    // 20 000 words of 360 ms in segments of ten, 2 000 turns of 3.6 s taking turns.
    const words = Array.from({ length: 20_000 }, (_, i) => w(i * 360, i * 360 + 300, `slovo${i}`));
    const segments = Array.from({ length: 2000 }, (_, i) => seg(words.slice(i * 10, i * 10 + 10)));
    const turns = Array.from({ length: 2000 }, (_, i) => t(i * 3600, (i + 1) * 3600, i % 2 ? 'B' : 'A'));
    const started = Date.now();
    expect(cli.assignSpeakers(segments, turns).speakers).toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('what the transcriber and the diarizer print', () => {
  it('keeps the cleaned word times of a segment, and leaves them out for the server', () => {
    const { segments } = cli.normalizeTranscript({
      segments: [{
        start_ms: 0, end_ms: 1000.4, text: ' Ahoj, test. ',
        words: [{ start_ms: 0.4, end_ms: 400, text: ' Ahoj, ' }, { start_ms: 400, end_ms: 'x', text: 'zlé' }, { start_ms: 500, end_ms: 600, text: '  ' }, { start_ms: 600, end_ms: 1000.4, text: 'test.' }],
      }, { start_ms: 2000, end_ms: 2500, text: 'Bez slov.' }],
    });
    expect(segments).toEqual([
      { start_ms: 0, end_ms: 1000, text: 'Ahoj, test.', words: [w(0, 400, 'Ahoj,'), w(600, 1000, 'test.')] },
      { start_ms: 2000, end_ms: 2500, text: 'Bez slov.' },
    ]);
    expect(cli.withoutWords([...segments, { start_ms: 3000, end_ms: 3500, text: 'Áno.', speaker: 'S2' }])).toEqual([
      { start_ms: 0, end_ms: 1000, text: 'Ahoj, test.' }, { start_ms: 2000, end_ms: 2500, text: 'Bez slov.' }, { start_ms: 3000, end_ms: 3500, text: 'Áno.', speaker: 'S2' },
    ]);
  });

  it('cleans the turns of the diarizer', () => {
    expect(cli.normalizeDiarization({
      model: 'pyannote/speaker-diarization-community-1',
      turns: [{ start_ms: 0.4, end_ms: 900, speaker: 'S1' }, { start_ms: 900, end_ms: 900, speaker: 'S2' }, { start_ms: 'x', end_ms: 1, speaker: 'S1' }, { start_ms: 1000, end_ms: 2000, speaker: '' }],
    })).toEqual({ model: 'pyannote/speaker-diarization-community-1', turns: [t(0, 900, 'S1')] });
    expect(cli.normalizeDiarization({ turns: [] }).model).toBe(cli.DIARIZE_MODEL);
    expect(() => cli.normalizeDiarization({ speakers: 2 })).toThrow(/printed no turns/);
  });

  it("tells Whisper the report's project after the initial_prompt setting", () => {
    expect(cli.whisperPrompt('Tabula, prehrávač', 'demo')).toBe('Tabula, prehrávač demo');
    expect(cli.whisperPrompt('  Fastify ', 'demo')).toBe('Fastify demo');
    expect(cli.whisperPrompt('', 'demo')).toBe('demo');
    expect(cli.whisperPrompt(undefined, '')).toBeNull();
  });

  it('reads the speaker recognition setting', () => {
    expect(cli.diarizeSettings(undefined)).toBeNull();
    expect(cli.diarizeSettings(null)).toBeNull();
    expect(cli.diarizeSettings({ python: 'py.exe', script: 'diarize.py' })).toEqual({ python: ['py.exe'], script: 'diarize.py' });
    expect(cli.diarizeSettings({ python: ['node', 'fake.mjs'], script: 'd.mjs' })).toEqual({ python: ['node', 'fake.mjs'], script: 'd.mjs' });
    expect(() => cli.diarizeSettings('yes')).toThrow(/worker\.diarize in .* must be/);
    expect(() => cli.diarizeSettings({ python: 'py.exe' })).toThrow(/worker\.diarize in .* must be/);
    expect(() => cli.diarizeSettings({ python: 1, script: 'd.py' })).toThrow(/worker\.diarize\.python/);
  });
});

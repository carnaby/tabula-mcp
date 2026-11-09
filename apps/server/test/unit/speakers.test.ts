import { describe, expect, it } from 'vitest';
import {
  applyAgentNames, applyUserNames, cleanDiarization, cleanSpeakerName, rankNames, speakersIn, speakerView,
} from '../../src/domain/speakers.js';

const NOW = new Date('2026-11-08T10:00:00.000Z');
const AT = NOW.toISOString();
const seg = (speaker: string | undefined, start = 0) => ({ start_ms: start, end_ms: start + 500, text: 'x', ...(speaker ? { speaker } : {}) });

describe('speaker names', () => {
  it('cleans a name: whitespace collapsed, diacritics and emoji kept, 60 characters counted as code points', () => {
    expect(cleanSpeakerName('  Eva \n Novák ', 'S1')).toBe('Eva Novák');
    expect(cleanSpeakerName('Tomáš 🎧', 'S2')).toBe('Tomáš 🎧');
    expect(cleanSpeakerName('😀'.repeat(60), 'S1')).toBe('😀'.repeat(60));
    expect(() => cleanSpeakerName('a'.repeat(61), 'S1')).toThrow(/S1 is 61 characters; the limit is 60/);
    expect(() => cleanSpeakerName(`a${String.fromCharCode(0)}b`, 'S1')).toThrow(/control characters/);
    expect(() => cleanSpeakerName(`a${String.fromCharCode(7)}b`, 'S1')).toThrow(/control characters/);
    expect(cleanSpeakerName('   ', 'S1')).toBe('');
    for (const bad of [42, null, undefined, ['Eva'], { name: 'x' }]) {
      expect(() => cleanSpeakerName(bad as never, 'S1')).toThrow(/the name of S1 must be a string/);
    }
  });

  it('lists the speakers in the order they first speak', () => {
    expect(speakersIn([seg('S2'), seg(undefined), seg('S1'), seg('S2')])).toEqual(['S2', 'S1']);
  });

  it("sets and clears the user's names, and refuses a speaker the transcript does not have", () => {
    const current = { S2: { name: 'Tomáš', by: 'agent' as const, at: AT } };
    expect(applyUserNames(current, ['S1', 'S2'], { S1: ' Eva ', S2: '' }, NOW)).toEqual({ S1: { name: 'Eva', by: 'user', at: AT } });
    // Confirming Claude's name makes it the user's.
    expect(applyUserNames(current, ['S1', 'S2'], { S2: 'Tomáš' }, NOW)).toEqual({ S2: { name: 'Tomáš', by: 'user', at: AT } });
    expect(() => applyUserNames({}, ['S1', 'S2'], { S3: 'Peter' }, NOW)).toThrow(/unknown speaker S3; the transcript has S1, S2/);
    expect(() => applyUserNames({}, [], { S1: 'Peter' }, NOW)).toThrow(/the transcript has none/);
  });

  it("lets an agent fill empty names and replace an agent's, never the user's", () => {
    const earlier = '2026-11-01T00:00:00.000Z';
    const current = { S1: { name: 'Eva', by: 'user' as const, at: earlier }, S2: { name: 'Tomi', by: 'agent' as const, at: earlier } };
    const r = applyAgentNames(current, ['S1', 'S2', 'S3'], { S1: 'Marek', S2: 'Tomáš', S3: 'Peter' }, NOW);
    expect(r.speakers).toEqual({ S1: current.S1, S2: { name: 'Tomáš', by: 'agent', at: AT }, S3: { name: 'Peter', by: 'agent', at: AT } });
    expect(r.written).toEqual({ S2: 'Tomáš', S3: 'Peter' });
    expect(r.skipped).toEqual([{ speaker: 'S1', reason: 'the user named S1 "Eva"; a name from the user is never replaced' }]);
    expect(() => applyAgentNames(current, ['S1', 'S2'], { S9: 'Peter' }, NOW)).toThrow(/unknown speaker S9/);
    expect(() => applyAgentNames(current, ['S1', 'S2'], { S2: ' ' }, NOW)).toThrow(/the name of S2 is empty/);
  });

  it("suggests this report's names first, then the project's, newest first, each once", () => {
    const user = (name: string, at: string) => ({ name, by: 'user' as const, at });
    const rows = [
      { reportId: 'other', speakers: { S1: user('Peter', '2026-11-07T00:00:00.000Z'), S2: { name: 'eva', by: 'agent' as const, at: '2026-11-06T00:00:00.000Z' } } },
      { reportId: 'this', speakers: { S1: user('Eva', '2026-11-01T00:00:00.000Z'), S2: user('Tomáš', '2026-11-02T00:00:00.000Z') } },
    ];
    expect(rankNames(rows, 'this')).toEqual(['Tomáš', 'Eva', 'Peter']);
    const many = [{ reportId: 'x', speakers: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`S${i + 1}`, user(`Name ${i}`, AT)])) }];
    expect(rankNames(many, 'this')).toHaveLength(20);
  });

  it('shows speakers to agents only when more than one was recognized', () => {
    const segments = [seg('S1', 0), seg('S2', 1000)];
    expect(speakerView(segments, { model: 'm', speakers: 2 }, { S1: { name: 'Eva', by: 'user', at: AT } })).toEqual({
      header: 'Speakers: S1 = Eva (named by user), S2 = not named', labels: { S1: 'Eva', S2: 'S2' },
    });
    expect(speakerView(segments, { model: 'm', speakers: 2 }, { S2: { name: 'Tomáš', by: 'agent', at: AT } }).header)
      .toBe('Speakers: S1 = not named, S2 = Tomáš (named by Claude)');
    expect(speakerView([seg('S1')], { model: 'm', speakers: 1 }, {})).toEqual({ header: null, labels: null });
    expect(speakerView([seg(undefined)], { model: 'm', speakers: 2 }, {})).toEqual({ header: null, labels: null });
    expect(speakerView(segments, null, {})).toEqual({ header: null, labels: null });
    expect(speakerView(segments, { error: 'CUDA is not available' }, {})).toEqual({ header: 'Speakers not recognized: CUDA is not available', labels: null });
  });

  it('cleans the diarization a worker reports', () => {
    expect(cleanDiarization(null)).toBeNull();
    expect(cleanDiarization(undefined)).toBeNull();
    expect(cleanDiarization({ model: 'pyannote/speaker-diarization-community-1', speakers: 2 })).toEqual({ model: 'pyannote/speaker-diarization-community-1', speakers: 2 });
    expect(cleanDiarization({ error: ` a\n  b${String.fromCharCode(1)}c ` })).toEqual({ error: 'a b c' });
    expect(cleanDiarization({ error: ' ' })).toEqual({ error: 'unknown error' });
    expect(() => cleanDiarization({ error: 'x'.repeat(2001) })).toThrow(/2000 characters/);
    expect(() => cleanDiarization({ model: 'm', speakers: 100 })).toThrow(/0 to 99/);
    expect(() => cleanDiarization({ model: '', speakers: 2 })).toThrow(/model name/);
    // Types are checked here too, not only by the route schemas.
    for (const bad of ['text', 7, true, ['x'], {}]) {
      expect(() => cleanDiarization(bad as never)).toThrow(/diarization/);
    }
    expect(() => cleanDiarization({ error: 5 } as never)).toThrow(/diarization.error must be a string/);
    expect(() => cleanDiarization({ error: null } as never)).toThrow(/diarization.error must be a string/);
    expect(() => cleanDiarization({ model: 123, speakers: 2 } as never)).toThrow(/model name/);
    expect(() => cleanDiarization({ model: ['m'], speakers: 2 } as never)).toThrow(/model name/);
    expect(() => cleanDiarization({ model: 'm', speakers: '2' } as never)).toThrow(/0 to 99/);
    expect(() => cleanDiarization({ model: 'm', speakers: 1.5 })).toThrow(/0 to 99/);
    expect(() => cleanDiarization({ model: 'm', speakers: -1 })).toThrow(/0 to 99/);
    expect(() => cleanDiarization({ model: 'm' } as never)).toThrow(/0 to 99/);
  });
});

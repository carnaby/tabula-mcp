import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Segment = { start_ms: number; end_ms: number; text: string };
type CliWorker = {
  VERSION: string;
  TRANSCRIBER_ENVIRONMENT_EXIT: number;
  formatClock(ms: number): string;
  workerBackoffMs(failures: number): number;
  shortError(text: unknown, max?: number): string;
  isNoAudioError(stderr: string): boolean;
  normalizeTranscript(raw: unknown): { language: string | null; duration_ms: number | null; segments: Segment[] };
  dataHome(env: Record<string, string | undefined>, platform: string, home: string): string;
  venvPython(venv: string, platform: string): string;
  commandLine(value: unknown, what: string): string[];
};

// A non-literal specifier keeps TypeScript from looking for type declarations of the plain .mjs file.
const cli = (await import(new URL('../../cli/tabula.mjs', import.meta.url).href)) as CliWorker;

describe('worker helpers of the CLI', () => {
  it('is version 1.2.0 and exits 3 for a broken transcription setup', () => {
    expect(cli.VERSION).toBe('1.2.0');
    expect(cli.TRANSCRIBER_ENVIRONMENT_EXIT).toBe(3);
  });

  it('formats clock times like the server', () => {
    expect([0, 5_400, 161_999, 3_723_000].map(cli.formatClock)).toEqual(['0:00', '0:05', '2:41', '1:02:03']);
  });

  it('backs off 2 s, 4 s, 8 s … up to a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(cli.workerBackoffMs)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });

  it('shortens errors to one line', () => {
    expect(cli.shortError('a\n  b\tc')).toBe('a b c');
    expect(cli.shortError('x'.repeat(400))).toHaveLength(300);
    expect(cli.shortError('')).toBe('no details');
  });

  it("recognises ffmpeg's errors for a recording without sound", () => {
    expect(cli.isNoAudioError('Output file #0 does not contain any stream')).toBe(true);
    expect(cli.isNoAudioError("Stream map '0:a' matches no streams.")).toBe(true);
    expect(cli.isNoAudioError('Invalid data found when processing input')).toBe(false);
  });

  it('normalizes what the transcriber printed', () => {
    expect(
      cli.normalizeTranscript({
        language: 'sk',
        duration_ms: 4200.4,
        segments: [
          { start_ms: 161000, end_ms: 163000, text: ' Tu sa\n zasekne. ' },
          { start_ms: 0.4, end_ms: 1500.6, text: 'Ahoj.' },
          { start_ms: 2000, end_ms: 1000, text: 'koniec pred začiatkom' },
          { start_ms: 'x', end_ms: 1, text: 'zlé číslo' },
          { start_ms: 3000, end_ms: 3500, text: '   ' },
        ],
      }),
    ).toEqual({
      language: 'sk',
      duration_ms: 4200,
      segments: [
        { start_ms: 0, end_ms: 1501, text: 'Ahoj.' },
        { start_ms: 2000, end_ms: 2000, text: 'koniec pred začiatkom' },
        { start_ms: 161000, end_ms: 163000, text: 'Tu sa zasekne.' },
      ],
    });
    expect(cli.normalizeTranscript({ language: '', duration_ms: null, segments: [] })).toEqual({ language: null, duration_ms: null, segments: [] });
    expect(() => cli.normalizeTranscript({ text: 'no list' })).toThrow(/no segments/);
    expect(() => cli.normalizeTranscript(null)).toThrow(/no segments/);
  });

  it('keeps its data in LOCALAPPDATA on Windows and in XDG_DATA_HOME elsewhere', () => {
    expect(cli.dataHome({ TABULA_DATA_DIR: 'X' }, 'win32', 'H')).toBe('X');
    expect(cli.dataHome({ LOCALAPPDATA: 'L' }, 'win32', 'H')).toBe(join('L', 'tabula'));
    expect(cli.dataHome({}, 'win32', 'H')).toBe(join('H', 'AppData', 'Local', 'tabula'));
    expect(cli.dataHome({ XDG_DATA_HOME: 'D' }, 'linux', 'H')).toBe(join('D', 'tabula'));
    expect(cli.dataHome({}, 'darwin', 'H')).toBe(join('H', '.local', 'share', 'tabula'));
  });

  it('finds the Python of a virtual environment', () => {
    expect(cli.venvPython('V', 'win32')).toBe(join('V', 'Scripts', 'python.exe'));
    expect(cli.venvPython('V', 'linux')).toBe(join('V', 'bin', 'python'));
  });

  it('accepts a program as a path or as a list of strings', () => {
    expect(cli.commandLine('ffmpeg', 'ffmpeg')).toEqual(['ffmpeg']);
    expect(cli.commandLine(['node', 'fake ffmpeg.mjs'], 'ffmpeg')).toEqual(['node', 'fake ffmpeg.mjs']);
    expect(() => cli.commandLine('', 'python')).toThrow(/worker\.python/);
    expect(() => cli.commandLine([1], 'python')).toThrow(/worker\.python/);
  });
});

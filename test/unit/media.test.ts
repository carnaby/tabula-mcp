import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTimestamp } from '../../src/domain/reports.js';
import { childEnv, downscaleImage, probeDurationMs, Semaphore } from '../../src/media/ffmpeg.js';
import { signMediaPath, verifyMediaSignature } from '../../src/media/sign.js';
import { sniff } from '../../src/media/sniff.js';
import { HAS_FFMPEG, headerDuration, hugePng, liveWebm, PNG } from '../media-fixtures.js';

const pad = (head: number[] | string, n = 64) => {
  const b = Buffer.alloc(n);
  (typeof head === 'string' ? Buffer.from(head, 'latin1') : Buffer.from(head)).copy(b);
  return b;
};
const ftyp = (brand: string) => pad(`\x00\x00\x00\x18ftyp${brand}`);

describe('sniff', () => {
  it('recognizes the accepted formats from their bytes', () => {
    expect(sniff(PNG)).toMatchObject({ kind: 'image', mime: 'image/png' });
    expect(sniff(pad([0xff, 0xd8, 0xff, 0xe0]))).toMatchObject({ kind: 'image', mime: 'image/jpeg', ext: 'jpg' });
    expect(sniff(pad('RIFF\x00\x00\x00\x00WEBPVP8 '))).toMatchObject({ mime: 'image/webp' });
    expect(sniff(ftyp('heic'))).toMatchObject({ kind: 'image', mime: 'image/heic' });
    expect(sniff(ftyp('qt  '))).toMatchObject({ kind: 'video', mime: 'video/quicktime', ext: 'mov' });
    expect(sniff(ftyp('isom'))).toMatchObject({ kind: 'video', mime: 'video/mp4' });
    expect(sniff(ftyp('M4A '))).toMatchObject({ kind: 'audio', mime: 'audio/mp4' });
    expect(sniff(ftyp('isom'), 'audio/mp4')).toMatchObject({ kind: 'audio' });
    expect(sniff(pad([0x1a, 0x45, 0xdf, 0xa3]), 'audio/webm;codecs=opus')).toMatchObject({ kind: 'audio', mime: 'audio/webm' });
    expect(sniff(pad([0x1a, 0x45, 0xdf, 0xa3]), 'video/webm')).toMatchObject({ kind: 'video', mime: 'video/webm' });
    expect(sniff(pad('ID3\x04'))).toMatchObject({ kind: 'audio', mime: 'audio/mpeg' });
    expect(sniff(pad([0xff, 0xfb, 0x90]))).toMatchObject({ mime: 'audio/mpeg' });
    expect(sniff(pad([0xff, 0xf1, 0x50]))).toMatchObject({ mime: 'audio/aac' });
    expect(sniff(pad('OggS'))).toMatchObject({ mime: 'audio/ogg' });
    expect(sniff(pad('RIFF\x00\x00\x00\x00WAVEfmt '))).toMatchObject({ mime: 'audio/wav' });
  });

  it('rejects what could run as a page on Tabula\'s origin, whatever the client claims', () => {
    expect(sniff(pad('<!doctype html><script>'), 'image/png')).toBeNull();
    expect(sniff(pad('<svg xmlns="http://www.w3.org/2000/svg">'), 'image/svg+xml')).toBeNull();
    expect(sniff(pad('%PDF-1.7'), 'application/pdf')).toBeNull();
    expect(sniff(pad('PK\x03\x04'))).toBeNull();
  });
});

describe('parseTimestamp', () => {
  it('reads seconds and clock times', () => {
    expect(parseTimestamp('2:41')).toBe(161_000);
    expect(parseTimestamp('1:02:03')).toBe(3_723_000);
    expect(parseTimestamp('161.5')).toBe(161_500);
    expect(parseTimestamp(12.25)).toBe(12_250);
    expect(() => parseTimestamp('soon')).toThrow(/mm:ss/);
    expect(() => parseTimestamp(-1)).toThrow();
  });

  it('refuses moments past 24 hours (they would not fit the database column either)', () => {
    expect(parseTimestamp('24:00:00')).toBe(86_400_000);
    expect(() => parseTimestamp('99999999')).toThrow(/past 24:00:00/);
    expect(() => parseTimestamp(86_400.5)).toThrow(/past 24:00:00/);
    expect(() => parseTimestamp('1e9')).toThrow(/mm:ss/);
  });
});

describe('ffmpeg hardening', () => {
  it('passes the child only PATH (and SYSTEMROOT on Windows), never secrets', () => {
    const env = { PATH: '/usr/bin', TABULA_TOKEN: 'x'.repeat(32), DATABASE_URL: 'postgres://u:p@db/t', SYSTEMROOT: 'C:/Windows' };
    expect(childEnv(env, 'linux')).toEqual({ PATH: '/usr/bin' });
    expect(childEnv(env, 'win32')).toEqual({ PATH: '/usr/bin', SYSTEMROOT: 'C:/Windows' });
  });

  it('runs at most `size` tasks at once and lets the rest wait their turn', async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const task = (ms: number) =>
      sem.run(async () => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, ms));
        running--;
        return ms;
      });
    const failing = sem.run(() => Promise.reject(new Error('boom')));
    const results = await Promise.all([task(20), task(10), task(5), task(1), failing.catch((e: Error) => e.message)]);
    expect(results).toEqual([20, 10, 5, 1, 'boom']);
    expect(peak).toBe(2);
    // A failed task frees its slot too.
    expect(await Promise.all([task(1), task(1)])).toEqual([1, 1]);
  });

  it.skipIf(!HAS_FFMPEG)('refuses to decode a picture with more pixels than the limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabula-png-'));
    const file = join(dir, 'huge.png');
    writeFileSync(file, hugePng());
    await expect(downscaleImage({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, file, 'image/png')).rejects.toThrow(/max pixel/);
  });

  it.skipIf(!HAS_FFMPEG)('measures a streamed WebM without a duration in its header (MediaRecorder) by its packets', async (ctx) => {
    const webm = liveWebm();
    if (!webm) return ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), 'tabula-webm-'));
    const file = join(dir, 'rec.webm');
    writeFileSync(file, webm);
    expect(headerDuration(file)).toBeNull();
    const ms = await probeDurationMs({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, file, 'video/webm');
    expect(ms).toBeGreaterThan(2900);
    expect(ms).toBeLessThan(3200);
  });
});

describe('signed media links', () => {
  const token = 'x'.repeat(32);
  const id = '00000000-0000-4000-8000-000000000001';
  const now = Date.UTC(2026, 10, 2, 10, 15);

  it('verifies its own signature until the expiry, which is rounded up to the hour', () => {
    const url = new URL(`http://h${signMediaPath(token, id, 3600, now)}`);
    const exp = Number(url.searchParams.get('exp'));
    expect(exp % 3600).toBe(0);
    expect(signMediaPath(token, id, 3600, now + 60_000)).toBe(url.pathname + url.search);
    expect(verifyMediaSignature(token, id, exp, url.searchParams.get('sig')!, now)).toBe(true);
    expect(verifyMediaSignature(token, id, exp, url.searchParams.get('sig')!, exp * 1000 + 1)).toBe(false);
    expect(verifyMediaSignature('y'.repeat(32), id, exp, url.searchParams.get('sig')!, now)).toBe(false);
    expect(verifyMediaSignature(token, id.replace(/1$/, '2'), exp, url.searchParams.get('sig')!, now)).toBe(false);
    expect(verifyMediaSignature(token, id, exp + 3600, url.searchParams.get('sig')!, now)).toBe(false);
  });
});

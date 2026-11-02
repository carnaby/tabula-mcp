import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

/** ffmpeg is optional on developer machines; tests that need it are skipped without it. */
export const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

/** A valid 1×1 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A 3-second 320×240 test video (MP4, H.264), generated once per test file. Needs ffmpeg. */
export function testVideo(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'tabula-video-'));
  const out = join(dir, 'clip.mp4');
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', out,
  ]);
  if (r.status !== 0) {
    // Some ffmpeg builds lack libx264; MPEG-4 Part 2 in MP4 works everywhere.
    const r2 = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10', '-c:v', 'mpeg4', out]);
    if (r2.status !== 0) throw new Error(`ffmpeg could not create a test video: ${r2.stderr}`);
  }
  return readFileSync(out);
}

/**
 * A 3-second WebM written the way the browser's MediaRecorder writes it: streamed (live), so without a Duration
 * element and without a seek index. Null when this ffmpeg can't encode VP8/Opus.
 */
export function liveWebm(): Buffer | null {
  const r = spawnSync(
    'ffmpeg',
    [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10', '-f', 'lavfi', '-i', 'sine=duration=3',
      '-c:v', 'libvpx', '-deadline', 'realtime', '-c:a', 'libopus', '-f', 'webm', '-live', '1', 'pipe:1',
    ],
    { maxBuffer: 50 * 1024 * 1024 },
  );
  return r.status === 0 && r.stdout.length > 0 ? r.stdout : null;
}

/** A small PNG whose header declares 9000×9000 pixels (81 Mpx): decoding it would need hundreds of MB. */
export function hugePng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(9000, 0);
  ihdr.writeUInt32BE(9000, 4);
  ihdr[8] = 8; // 8-bit grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(9001 * 16))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ffprobe's container duration of a file in seconds, or null when the header has none ("N/A"). */
export function headerDuration(file: string): number | null {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const s = Number.parseFloat(String(r.stdout).trim());
  return Number.isFinite(s) ? s : null;
}

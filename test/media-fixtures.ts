import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

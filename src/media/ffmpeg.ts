import { spawn } from 'node:child_process';

export type FfmpegPaths = { ffmpeg: string; ffprobe: string };

/** Longest edge of images handed to agents: larger images only cost tokens. */
export const AGENT_IMAGE_EDGE = 1568;

function run(cmd: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited with ${code}: ${err.trim()}`));
    });
  });
}

/** Duration in milliseconds, or null when ffprobe is missing or the file has none. */
export async function probeDurationMs(paths: FfmpegPaths, file: string): Promise<number | null> {
  try {
    const out = await run(paths.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 20_000);
    const s = Number.parseFloat(out.toString().trim());
    return Number.isFinite(s) ? Math.round(s * 1000) : null;
  } catch {
    return null;
  }
}

const scale = `scale='min(${AGENT_IMAGE_EDGE},iw)':'min(${AGENT_IMAGE_EDGE},ih)':force_original_aspect_ratio=decrease`;

/** One JPEG frame of a video at the given moment. Seeking before -i decodes only from the nearest keyframe. */
export function extractFrame(paths: FfmpegPaths, file: string, atMs: number): Promise<Buffer> {
  return run(
    paths.ffmpeg,
    ['-nostdin', '-v', 'error', '-ss', (atMs / 1000).toFixed(3), '-i', file, '-frames:v', '1', '-vf', scale, '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
    60_000,
  ).then((b) => {
    if (b.length === 0) throw new Error('no frame at that moment (past the end of the video?)');
    return b;
  });
}

/** A photo as a JPEG small enough for an agent (HEIC from iPhones too, when ffmpeg supports it). */
export function downscaleImage(paths: FfmpegPaths, file: string): Promise<Buffer> {
  return run(paths.ffmpeg, ['-nostdin', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', scale, '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], 60_000);
}

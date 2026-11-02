import { spawn } from 'node:child_process';

export type FfmpegPaths = { ffmpeg: string; ffprobe: string };

/** Longest edge of images handed to agents: larger images only cost tokens. */
export const AGENT_IMAGE_EDGE = 1568;
/** Pictures with more pixels are refused before decoding: a tiny file can declare huge dimensions and exhaust memory. */
export const MAX_PIXELS = 64 * 1024 * 1024;
/** How many ffmpeg/ffprobe processes may run at once; the rest wait for their turn. */
export const MAX_CONCURRENT = 2;
/** Output beyond this is not a frame or a probe result we want; the process is killed. */
const MAX_OUTPUT = 32 * 1024 * 1024;

/** A counting semaphore: run() waits until fewer than `size` tasks are running. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(readonly size: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.size) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next waiter, or free it.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const slots = new Semaphore(MAX_CONCURRENT);

/** ffmpeg reads untrusted files: it gets only what it needs to start, never the token or the database URL. */
export function childEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PATH: env.PATH ?? '' };
  if (platform === 'win32' && env.SYSTEMROOT) out.SYSTEMROOT = env.SYSTEMROOT;
  return out;
}

/** The demuxer for a type detected by sniff(), so ffmpeg never guesses the format of an upload itself. */
const DEMUXERS: Record<string, string> = {
  'image/jpeg': 'jpeg_pipe',
  'image/png': 'png_pipe',
  'image/webp': 'webp_pipe',
  'image/gif': 'gif',
  'video/mp4': 'mov',
  'video/quicktime': 'mov',
  'audio/mp4': 'mov',
  'video/webm': 'matroska',
  'audio/webm': 'matroska',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/aac': 'aac',
};

/** Input options shared by every run: local files only (no URLs or playlists), a pixel limit, a fixed demuxer. */
function input(file: string, mime: string): string[] {
  const format = DEMUXERS[mime];
  return ['-protocol_whitelist', 'file', '-max_pixels', String(MAX_PIXELS), ...(format ? ['-f', format] : []), '-i', file];
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return slots.run(
    () =>
      new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
        const out: Buffer[] = [];
        let size = 0;
        let err = '';
        const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
        p.stdout.on('data', (d: Buffer) => {
          size += d.length;
          if (size > MAX_OUTPUT) p.kill('SIGKILL');
          else out.push(d);
        });
        p.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
        p.on('error', (e) => { clearTimeout(timer); reject(e); });
        p.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0 && size <= MAX_OUTPUT) resolve(Buffer.concat(out));
          else reject(new Error(`${cmd} exited with ${code}: ${err.trim()}`));
        });
      }),
  );
}

/**
 * Duration in milliseconds, or null when ffprobe is missing or the file has none. Live recordings (the browser's
 * MediaRecorder) have no duration in the header; then it is where the last packet ends.
 */
export async function probeDurationMs(paths: FfmpegPaths, file: string, mime: string): Promise<number | null> {
  try {
    const out = await run(paths.ffprobe, ['-v', 'error', ...input(file, mime), '-show_entries', 'format=duration', '-of', 'csv=p=0'], 20_000);
    const s = Number.parseFloat(out.toString().trim());
    if (Number.isFinite(s) && s > 0) return Math.round(s * 1000);
    const packets = await run(
      paths.ffprobe,
      ['-v', 'error', ...input(file, mime), '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0'],
      120_000,
    );
    let end = 0;
    for (const line of packets.toString().split(/\r?\n/)) {
      const [pts, dur] = line.split(',').map((x) => Number.parseFloat(x));
      if (pts !== undefined && Number.isFinite(pts)) end = Math.max(end, pts + (dur !== undefined && Number.isFinite(dur) ? dur : 0));
    }
    return end > 0 ? Math.round(end * 1000) : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite a WebM without re-encoding so it gets a duration and a seek index: MediaRecorder writes neither, and
 * without them the browser can't seek in the video and its length is unknown. Throws when ffmpeg can't.
 */
export async function remuxWebm(paths: FfmpegPaths, file: string, mime: string, out: string): Promise<void> {
  await run(paths.ffmpeg, ['-nostdin', '-v', 'error', ...input(file, mime), '-map', '0', '-c', 'copy', '-f', 'webm', '-y', out], 600_000);
}

const scale = `scale='min(${AGENT_IMAGE_EDGE},iw)':'min(${AGENT_IMAGE_EDGE},ih)':force_original_aspect_ratio=decrease`;

/** Thrown when the moment is past the last frame; its message is safe to show. */
export class NoFrameError extends Error {}

/** One JPEG frame of a video at the given moment. Seeking before -i decodes only from the nearest keyframe. */
export function extractFrame(paths: FfmpegPaths, file: string, mime: string, atMs: number): Promise<Buffer> {
  return run(
    paths.ffmpeg,
    ['-nostdin', '-v', 'error', '-ss', (atMs / 1000).toFixed(3), ...input(file, mime), '-frames:v', '1', '-vf', scale, '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
    60_000,
  ).then((b) => {
    if (b.length === 0) throw new NoFrameError('no frame at that moment (past the end of the video?)');
    return b;
  });
}

/** A photo as a JPEG small enough for an agent (HEIC from iPhones too, when ffmpeg supports it). */
export function downscaleImage(paths: FfmpegPaths, file: string, mime: string): Promise<Buffer> {
  return run(
    paths.ffmpeg,
    ['-nostdin', '-v', 'error', ...input(file, mime), '-frames:v', '1', '-vf', scale, '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
    60_000,
  );
}

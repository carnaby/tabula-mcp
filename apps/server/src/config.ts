import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TABULA_TOKEN: z.string().min(32, 'TABULA_TOKEN must be at least 32 characters'),
  TABULA_CONNECTOR_SECRET: z.preprocess(
    emptyToUndefined,
    z.string().min(32, 'TABULA_CONNECTOR_SECRET must be at least 32 characters').optional(),
  ),
  TABULA_FORNAX_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  TABULA_FORNAX_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  TABULA_FORNAX_PRIORITY: z.preprocess(emptyToUndefined, z.enum(['low', 'normal', 'high']).default('high')),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  WEB_DIST: z.string().default('web/dist'),
  TABULA_MEDIA_DIR: z.string().default('data/media'),
  TABULA_MEDIA_MAX_MB: z.coerce.number().int().positive().default(1024),
  TABULA_MEDIA_PURGE_HOURS: z.coerce.number().min(0).default(24),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
});

export type FornaxConfig = { url: string; token: string; priority: 'low' | 'normal' | 'high' };

export type Config = {
  databaseUrl: string;
  token: string;
  connectorSecret: string | undefined;
  /** The Fornax job queue that transcribes recordings. Unset = transcription is off. */
  fornax: FornaxConfig | undefined;
  port: number;
  host: string;
  webDist: string;
  media: {
    /** Where attachments of reports are stored (a volume in Docker). */
    dir: string;
    maxBytes: number;
    /** Video and audio of a closed report are deleted this many hours after it was closed. */
    purgeAfterHours: number;
    ffmpeg: string;
    ffprobe: string;
  };
};

function fornaxUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid configuration: TABULA_FORNAX_URL must be an http(s) URL');
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) {
    throw new Error('Invalid configuration: TABULA_FORNAX_URL must be an http(s) URL without a path');
  }
  return u.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const e = parsed.data;
  let fornax: FornaxConfig | undefined;
  if (e.TABULA_FORNAX_URL !== undefined || e.TABULA_FORNAX_TOKEN !== undefined) {
    if (e.TABULA_FORNAX_URL === undefined) throw new Error('Invalid configuration: TABULA_FORNAX_URL is required when TABULA_FORNAX_TOKEN is set');
    if (e.TABULA_FORNAX_TOKEN === undefined) throw new Error('Invalid configuration: TABULA_FORNAX_TOKEN is required when TABULA_FORNAX_URL is set');
    fornax = { url: fornaxUrl(e.TABULA_FORNAX_URL), token: e.TABULA_FORNAX_TOKEN, priority: e.TABULA_FORNAX_PRIORITY };
  }
  return {
    databaseUrl: e.DATABASE_URL,
    token: e.TABULA_TOKEN,
    connectorSecret: e.TABULA_CONNECTOR_SECRET,
    fornax,
    port: e.PORT,
    host: e.HOST,
    webDist: e.WEB_DIST,
    media: {
      dir: e.TABULA_MEDIA_DIR,
      maxBytes: e.TABULA_MEDIA_MAX_MB * 1024 * 1024,
      purgeAfterHours: e.TABULA_MEDIA_PURGE_HOURS,
      ffmpeg: e.FFMPEG_PATH,
      ffprobe: e.FFPROBE_PATH,
    },
  };
}

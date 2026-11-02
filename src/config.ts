import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TABULA_TOKEN: z.string().min(32, 'TABULA_TOKEN must be at least 32 characters'),
  TABULA_CONNECTOR_SECRET: z.preprocess(
    emptyToUndefined,
    z.string().min(32, 'TABULA_CONNECTOR_SECRET must be at least 32 characters').optional(),
  ),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  WEB_DIST: z.string().default('web/dist'),
  TABULA_MEDIA_DIR: z.string().default('data/media'),
  TABULA_MEDIA_MAX_MB: z.coerce.number().int().positive().default(1024),
  TABULA_MEDIA_PURGE_HOURS: z.coerce.number().min(0).default(24),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
});

export type Config = {
  databaseUrl: string;
  token: string;
  connectorSecret: string | undefined;
  port: number;
  host: string;
  webDist: string;
  media: {
    /** Where attachments of bug reports are stored (a volume in Docker). */
    dir: string;
    maxBytes: number;
    /** Video and audio of a closed report are deleted this many hours after it was closed. */
    purgeAfterHours: number;
    ffmpeg: string;
    ffprobe: string;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    token: e.TABULA_TOKEN,
    connectorSecret: e.TABULA_CONNECTOR_SECRET,
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

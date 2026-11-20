import { isIP } from 'node:net';
import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TABULA_TOKEN: z.string().min(32, 'TABULA_TOKEN must be at least 32 characters'),
  TABULA_CONNECTOR_SECRET: z.preprocess(
    emptyToUndefined,
    z.string().min(32, 'TABULA_CONNECTOR_SECRET must be at least 32 characters').optional(),
  ),
  TABULA_PUBLIC_URL: z.preprocess(emptyToUndefined, z.string().optional()),
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
  /**
   * The public address, https://<host> without a path: the OAuth issuer, the base of /mcp and /api as resources and
   * the passkey domain. Unset: no OAuth and no passkeys, only TABULA_TOKEN.
   */
  publicUrl: string | undefined;
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

export const PUBLIC_URL_RULE = 'must be https://<host>[:<port>] without a path, query or fragment, or http://localhost[:<port>]';
export const PUBLIC_URL_IP_RULE = 'must name a host, not an IP address: passkeys (WebAuthn) refuse an IP address as the relying party ID';

/** An IPv4 or IPv6 literal; URL keeps the brackets around an IPv6 hostname. */
const isIpHost = (hostname: string) => isIP(hostname.replace(/^\[|\]$/g, '')) !== 0;

/** Whether an otherwise https address names an IP literal: it gets its own startup error. */
const isHttpsIp = (raw: string) => {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && isIpHost(url.hostname);
  } catch {
    return false;
  }
};

/**
 * The address in the one form clients compare it in, or null. A single trailing slash is dropped; anything else must
 * already be exactly the URL's origin (no path, query, fragment, user, upper case). An issuer is compared byte for
 * byte (RFC 8414 §3.3) and the passkey origin too, so nothing is rewritten silently. Plain http only on localhost, and
 * never an IP address, https included: WebAuthn refuses an IP address as the RP ID.
 */
export function normalizePublicUrl(raw: string): string | null {
  const candidate = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.origin !== candidate) return null;
  if (url.protocol === 'https:') return isIpHost(url.hostname) ? null : url.origin;
  if (url.protocol === 'http:' && url.hostname === 'localhost') return url.origin;
  return null;
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
  let publicUrl: string | undefined;
  if (e.TABULA_PUBLIC_URL !== undefined) {
    const normalized = normalizePublicUrl(e.TABULA_PUBLIC_URL);
    if (normalized === null) {
      const rule = isHttpsIp(e.TABULA_PUBLIC_URL) ? PUBLIC_URL_IP_RULE : PUBLIC_URL_RULE;
      throw new Error(`Invalid configuration: TABULA_PUBLIC_URL ${rule}`);
    }
    publicUrl = normalized;
  }
  return {
    databaseUrl: e.DATABASE_URL,
    token: e.TABULA_TOKEN,
    connectorSecret: e.TABULA_CONNECTOR_SECRET,
    publicUrl,
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

/** Lines to log once at start about settings that no longer do anything. */
export function configWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];
  if (env.TABULA_WORKER_TOKEN) warnings.push('TABULA_WORKER_TOKEN is no longer used; transcription runs on Fornax (TABULA_FORNAX_URL)');
  return warnings;
}

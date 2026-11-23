import { asc, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, inject } from 'vitest';
import { createClient, createConnection } from '../src/auth/oauth/store.js';
import { hashSecret, newSecret } from '../src/auth/secrets.js';
import type { ResourceKind } from '../src/auth/settings.js';
import type { Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { oauthAccessTokens, projects, reportJobs } from '../src/db/schema.js';
import { storeTranscript, type TranscriptInput } from '../src/domain/jobs.js';

export function useTestDb(): Db {
  const { db, close } = createDb(inject('databaseUrl'));
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE memories, notes, thoughts, project_files, project_file_revisions, reports, report_attachments, report_jobs, report_transcripts, messages, message_events, message_tokens, oauth_clients, oauth_pending, oauth_connections, oauth_codes, oauth_refresh_tokens, oauth_access_tokens, app_idempotency, passkeys, passkey_registrations, webauthn_challenges, ui_sessions CASCADE`);
    // The media signing key outlives a test like it outlives a restart: an app built in beforeAll keeps signing with it.
    await db.execute(sql`DELETE FROM settings WHERE key <> 'media_signing_key'`);
    await db.execute(sql`DELETE FROM projects WHERE id <> 'global'`);
  });
  afterAll(close);
  return db;
}

export async function seedProject(db: Db, id: string): Promise<void> {
  await db.insert(projects).values({ id, name: id, description: `${id} project` });
}

/** An OAuth access token for /api of a connection named "cli": what the CLI and the old REST tests send. */
export const TEST_TOKEN = 't'.repeat(32);
/** An OAuth access token for /mcp of a connection named "claude-code". */
export const TEST_MCP_TOKEN = 'm'.repeat(32);
/** A token that opens nothing: the retired worker token, sent to check that it is refused. */
export const TEST_WORKER_TOKEN = 'w'.repeat(32);
/** An OAuth access token for /app-api of a connection named "klara": an app that writes on the owner's behalf. */
export const TEST_APP_TOKEN = 'k'.repeat(32);
/** The public URL of servers under test that have OAuth and passkeys on (requests via inject; the port is not used). */
export const TEST_PUBLIC_URL = 'http://localhost:3999';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: 'unused-in-tests',
    publicUrl: TEST_PUBLIC_URL,
    fornax: { url: 'https://fornax.example.com', token: 'f'.repeat(32), priority: 'high' },
    port: 0,
    host: '127.0.0.1',
    webDist: null,
    media: { dir: 'does-not-exist', maxBytes: 10 * 1024 * 1024, purgeAfterHours: 24, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    ...overrides,
  };
}

/** Fornax finished the oldest waiting job: its transcript is stored as the sync stores it. */
export async function finishNextJob(db: Db, input: TranscriptInput): Promise<void> {
  const [job] = await db
    .select({ id: reportJobs.id })
    .from(reportJobs)
    .where(inArray(reportJobs.status, ['queued', 'running']))
    .orderBy(asc(reportJobs.runAfter), asc(reportJobs.createdAt))
    .limit(1);
  if (!job) throw new Error('no transcription job waits');
  await db.transaction((tx) => storeTranscript(tx, job.id, input));
}

/** A live connection with an access token of a known value, made directly in the database (no consent page). */
export async function issueTestAccessToken(
  db: Db, opts: { resource: ResourceKind; name?: string; value?: string },
): Promise<{ value: string; connectionId: string }> {
  const redirectUri = 'https://client.example.com/callback';
  const client = await createClient(db, { clientName: 'Test client', redirectUris: [redirectUri] });
  const connection = await createConnection(db, {
    clientId: client.id, name: opts.name ?? `test-${opts.resource}`, resource: opts.resource, scope: opts.resource, redirectUri,
  });
  const value = opts.value ?? newSecret();
  await db.insert(oauthAccessTokens).values({
    hash: hashSecret(value), connectionId: connection.id, resource: opts.resource, expiresAt: new Date(Date.now() + 24 * 3600_000),
  });
  return { value, connectionId: connection.id };
}

/**
 * Both test tokens before every test (after useTestDb empties the tables); call it right after useTestDb. Never in a
 * file that creates its own connection named "cli" or "claude-code": a live connection name is unique.
 */
export function useTestTokens(db: Db): void {
  beforeEach(async () => {
    await issueTestAccessToken(db, { resource: 'api', name: 'cli', value: TEST_TOKEN });
    await issueTestAccessToken(db, { resource: 'mcp', name: 'claude-code', value: TEST_MCP_TOKEN });
  });
}

/** TEST_APP_TOKEN before every test; call it right after useTestDb, never in a file that makes its own "klara". */
export function useTestAppToken(db: Db): void {
  beforeEach(async () => {
    await issueTestAccessToken(db, { resource: 'app', name: 'klara', value: TEST_APP_TOKEN });
  });
}

/** config.json of a CLI logged in with OAuth whose access token is TEST_TOKEN (valid long enough not to refresh). */
export const cliConfig = (url: string) => ({
  url, oauth: { client_id: 'test-client', refresh_token: 'unused', access_token: TEST_TOKEN, expires_at: Date.now() + 3600_000 },
});

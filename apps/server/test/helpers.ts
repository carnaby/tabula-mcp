import { asc, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, inject } from 'vitest';
import type { Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { projects, reportJobs } from '../src/db/schema.js';
import { storeTranscript, type TranscriptInput } from '../src/domain/jobs.js';

export function useTestDb(): Db {
  const { db, close } = createDb(inject('databaseUrl'));
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE memories, notes, thoughts, project_files, project_file_revisions, reports, report_attachments, report_jobs, report_transcripts, messages, message_events, message_tokens, oauth_clients, oauth_pending, oauth_connections, oauth_codes, oauth_refresh_tokens, oauth_access_tokens, passkeys, passkey_registrations, webauthn_challenges, ui_sessions CASCADE`);
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

export const TEST_TOKEN = 't'.repeat(32);
export const TEST_SECRET = 's'.repeat(32);
/** A token that opens nothing: the retired worker token, sent to check that it is refused. */
export const TEST_WORKER_TOKEN = 'w'.repeat(32);
/** The public URL of servers under test that have OAuth and passkeys on (requests via inject; the port is not used). */
export const TEST_PUBLIC_URL = 'http://localhost:3999';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: 'unused-in-tests',
    token: TEST_TOKEN,
    connectorSecret: TEST_SECRET,
    publicUrl: undefined,
    fornax: { url: 'https://fornax.example.com', token: 'f'.repeat(32), priority: 'high' },
    port: 0,
    host: '127.0.0.1',
    webDist: 'does-not-exist',
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

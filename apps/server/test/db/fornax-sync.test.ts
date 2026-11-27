import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projects, reportAttachments, reportDocuments, reportJobs, reports, reportTranscripts } from '../../src/db/schema.js';
import { enqueueParse, getDocumentText, retryDocument } from '../../src/domain/documents.js';
import {
  DOCUMENT_GONE, enqueueTranscription, failPendingJobs, MAX_ATTEMPTS, MEDIA_GONE, retryTranscription, transcribeAgain, transcriptStates,
} from '../../src/domain/jobs.js';
import { type FornaxClient, fornaxClient, FornaxError } from '../../src/fornax/client.js';
import { createFornaxSync, FORNAX_CANCELED, FORNAX_FORGOT } from '../../src/fornax/sync.js';
import { MediaStore } from '../../src/media/store.js';
import { type FakeFornax, PENDING_MESSAGE, startFakeFornax } from '../fake-fornax.js';
import { useTestDb } from '../helpers.js';
import { silentWav } from '../media-fixtures.js';

const db = useTestDb();
const store = new MediaStore(mkdtempSync(join(tmpdir(), 'tabula-fornax-media-')), 10 * 1024 * 1024);
let fake: FakeFornax;
let client: FornaxClient;
const logged: Array<{ level: string; msg: string; obj: object }> = [];
const log = {
  info: (obj: object, msg: string) => logged.push({ level: 'info', msg, obj }),
  warn: (obj: object, msg: string) => logged.push({ level: 'warn', msg, obj }),
  error: (obj: object, msg: string) => logged.push({ level: 'error', msg, obj }),
};
const syncs: Array<ReturnType<typeof createFornaxSync>> = [];
const newSync = (c: FornaxClient = client, timing?: Parameters<typeof createFornaxSync>[0]['timing']) => {
  const s = createFornaxSync({ db, store, client: c, log, ...(timing ? { timing } : {}) });
  syncs.push(s);
  return s;
};

beforeEach(async () => {
  fake = await startFakeFornax();
  client = fornaxClient({ url: fake.url, token: fake.token, priority: 'high' });
  logged.length = 0;
  await db.insert(projects).values({ id: 'apollo', name: 'Apollo Player' });
});
afterEach(async () => {
  for (const s of syncs.splice(0)) await s.stop();
  await fake.close();
});

/** The queue takes `now`; the base lies ten minutes ahead of every row the tests insert with the real clock. */
const t0 = Date.now() + 10 * 60_000;
const at = (ms: number) => new Date(t0 + ms);

const AUDIO = silentWav(1);

/** A report (of Apollo, or without a project) with a WAV recording on disk, queued for transcription. */
async function recording(opts: { project?: string | null; durationMs?: number | null; queue?: boolean } = {}) {
  const [r] = await db
    .insert(reports)
    .values({ projectId: opts.project === undefined ? 'apollo' : opts.project, title: 'Player freezes', source: 'human', editedBy: 'human' })
    .returning();
  const id = randomUUID();
  const storageKey = `${r!.id}/${id}.wav`;
  await store.writeBuffer(storageKey, AUDIO);
  const [a] = await db
    .insert(reportAttachments)
    .values({
      id, reportId: r!.id, kind: 'audio', mime: 'audio/wav', size: AUDIO.length, sha256: 'x', fileName: 'voice note.wav', storageKey,
      durationMs: opts.durationMs ?? null, createdBy: 'human',
    })
    .returning();
  if (opts.queue !== false) await enqueueTranscription(db, id);
  return a!;
}

const jobOf = async (attachmentId: string) => (await db.select().from(reportJobs).where(eq(reportJobs.attachmentId, attachmentId)))[0]!;
const stateOf = async (attachmentId: string, now?: Date) => (await transcriptStates(db, [attachmentId], now)).get(attachmentId);
const fornaxJob = async (attachmentId: string) => fake.jobs.get((await jobOf(attachmentId)).fornaxJobId!)!;

const TRANSCRIPT = {
  model: 'large-v3',
  language: 'sk',
  duration_ms: 4200,
  segments: [
    { start_ms: 0, end_ms: 1500, text: ' Prehrávač zamrzne. ', speaker: 'S1' },
    { start_ms: 1600, end_ms: 3000, text: 'Po kliknutí na play.', speaker: 'S2' },
  ],
  diarization: { model: 'pyannote/speaker-diarization-community-1', speakers: 2 },
};
const succeeded = (transcript: unknown = TRANSCRIPT) => ({ state: 'succeeded' as const, files: new Map([['transcript.json', transcript]]) });

describe('the Fornax sync', () => {
  it('uploads a queued recording and submits it once, with the project name as the prompt', async () => {
    const a = await recording();
    const loose = await recording({ project: null });
    const sync = newSync();
    await sync.syncOnce(at(0));
    expect(fake.files.size).toBe(2);
    expect(fake.jobs.size).toBe(2);
    const job = await jobOf(a.id);
    expect(job).toMatchObject({ status: 'queued', attempts: 1, submitting: false, error: null, startedAt: at(0) });
    const fj = fake.jobs.get(job.fornaxJobId!)!;
    expect(fj).toMatchObject({ type: 'transcribe', params: { diarize: true, initial_prompt: 'Apollo Player' }, priority: 'high', group: 'tabula' });
    const file = fake.files.get(fj.inputs.audio!)!;
    expect(file.body.equals(AUDIO)).toBe(true);
    expect(file.name).toMatch(/\.wav$/);
    expect(job.fornaxChange).toBe(fj.change);
    expect((await fornaxJob(loose.id)).params).toEqual({ diarize: true });

    await sync.syncOnce(at(1000));
    await newSync().syncOnce(at(2000));
    expect(fake.jobs.size).toBe(2);
    expect(fake.files.size).toBe(2);
  });

  it('shows why a job waits in Fornax, and that it runs', async () => {
    const a = await recording();
    const sync = newSync();
    await sync.syncOnce(at(0));
    fake.setJob((await jobOf(a.id)).fornaxJobId!, { note: 'the worker is offline' });
    await sync.syncOnce(at(1000));
    expect(await stateOf(a.id, at(1000))).toEqual({ status: 'queued', attempts: 1, error: null, retryAt: null, note: 'the worker is offline' });
    fake.setJob((await jobOf(a.id)).fornaxJobId!, { state: 'running', note: null, progress: 0.3 });
    await sync.syncOnce(at(2000));
    expect(await stateOf(a.id, at(2000))).toMatchObject({ status: 'running', note: null });
    expect((await jobOf(a.id)).fornaxChange).toBe((await fornaxJob(a.id)).change);
  });

  it('stores a new note even when Fornax keeps the change value (its change leaves the note out)', async () => {
    const a = await recording();
    const sync = newSync();
    await sync.syncOnce(at(0));
    const id = (await jobOf(a.id)).fornaxJobId!;
    const change = (await jobOf(a.id)).fornaxChange;
    fake.setJob(id, { note: 'the worker is offline since 13:40' }, { sameChange: true });
    await sync.syncOnce(at(1000));
    expect(await stateOf(a.id, at(1000))).toMatchObject({ status: 'queued', note: 'the worker is offline since 13:40' });
    expect((await jobOf(a.id)).fornaxChange).toBe(change);
  });

  it('stores the whole percent and the message of a running job, and writes the row only when they change', async () => {
    const a = await recording();
    const sync = newSync();
    await sync.syncOnce(at(0));
    const id = (await jobOf(a.id)).fornaxJobId!;
    fake.setJob(id, { state: 'running', note: null, progress: 0.1, progress_message: 'extracting the audio' });
    await sync.syncOnce(at(1000));
    const running = await jobOf(a.id);
    expect(running).toMatchObject({ status: 'running', progress: 10, progressMessage: 'extracting the audio', updatedAt: at(1000) });
    expect(await stateOf(a.id)).toMatchObject({ status: 'running', progress: 10, progressMessage: 'extracting the audio' });
    // Finer progress with the same whole percent and message: Fornax's change value moves, the row stays.
    for (const [i, progress] of [0.101, 0.104].entries()) {
      fake.setJob(id, { progress });
      await sync.syncOnce(at(2000 + i));
    }
    expect(await jobOf(a.id)).toMatchObject({ progress: 10, updatedAt: at(1000), fornaxChange: running.fornaxChange });
    fake.setJob(id, { progress: 0.4213, progress_message: 'transcribing 01:23 / 10:00' });
    await sync.syncOnce(at(3000));
    expect(await jobOf(a.id)).toMatchObject({ progress: 42, progressMessage: 'transcribing 01:23 / 10:00', updatedAt: at(3000) });
    fake.setJob(id, { progress: 0.4249 });
    await sync.syncOnce(at(4000));
    expect((await jobOf(a.id)).updatedAt).toEqual(at(3000));
    fake.setJob(id, { progress_message: 'transcribing 01:30 / 10:00' });
    await sync.syncOnce(at(5000));
    expect(await jobOf(a.id)).toMatchObject({ progress: 42, progressMessage: 'transcribing 01:30 / 10:00', updatedAt: at(5000) });
    fake.setJob(id, succeeded());
    await sync.syncOnce(at(6000));
    expect((await jobOf(a.id)).status).toBe('done');
  });

  it('says when the recording could not be read, and tries again after the back-off', async () => {
    const a = await recording();
    // A directory in place of the file: stat works, reading fails.
    await store.remove(a.storageKey);
    mkdirSync(store.path(a.storageKey));
    // Like the real client, a body that fails to read surfaces as "unreachable".
    const reading: FornaxClient = {
      ...client,
      uploadFile: async (_name: string, body: Readable | ReadableStream) => {
        try {
          for await (const _chunk of body as Readable) {
            // drain
          }
        } catch {
          throw new FornaxError('Fornax is unreachable', null, false);
        }
        throw new Error('the directory was read');
      },
    };
    await newSync(reading).syncOnce(at(0));
    const job = await jobOf(a.id);
    expect(job).toMatchObject({ status: 'queued', attempts: 1, runAfter: at(60_000) });
    expect(job.error).toMatch(/^the recording could not be read \(E[A-Z]+\)$/);
  });

  it('stores the transcript when Fornax is done, and fills a missing duration only', async () => {
    const a = await recording();
    const b = await recording({ durationMs: 5000 });
    const sync = newSync();
    await sync.syncOnce(at(0));
    fake.setJob((await jobOf(a.id)).fornaxJobId!, succeeded());
    fake.setJob((await jobOf(b.id)).fornaxJobId!, succeeded());
    await sync.syncOnce(at(1000));
    expect(await jobOf(a.id)).toMatchObject({ status: 'done', error: null, finishedAt: at(1000), note: null });
    expect(await stateOf(a.id)).toMatchObject({
      status: 'done', language: 'sk', model: 'large-v3', diarization: TRANSCRIPT.diarization,
      segments: [
        { start_ms: 0, end_ms: 1500, text: 'Prehrávač zamrzne.', speaker: 'S1' },
        { start_ms: 1600, end_ms: 3000, text: 'Po kliknutí na play.', speaker: 'S2' },
      ],
    });
    const duration = async (id: string) => (await db.select().from(reportAttachments).where(eq(reportAttachments.id, id)))[0]!.durationMs;
    expect(await duration(a.id)).toBe(4200);
    expect(await duration(b.id)).toBe(5000);
    // A finished job is not asked about again.
    const asked = fake.requests.length;
    await sync.syncOnce(at(2000));
    expect(fake.requests.length).toBe(asked);
  });

  it('stores the transcript without speakers when speaker recognition failed', async () => {
    const a = await recording();
    const sync = newSync();
    await sync.syncOnce(at(0));
    fake.setJob((await jobOf(a.id)).fornaxJobId!, succeeded({ ...TRANSCRIPT, diarization: { error: 'the speaker recognition model is not downloaded' } }));
    await sync.syncOnce(at(1000));
    const s = await stateOf(a.id);
    expect(s).toMatchObject({ status: 'done', diarization: { error: 'the speaker recognition model is not downloaded' } });
    expect(s?.status === 'done' && s.segments.every((x) => x.speaker === undefined)).toBe(true);
  });

  it('fails a transcript Fornax sent in a shape Tabula cannot store', async () => {
    const a = await recording();
    const sync = newSync();
    await sync.syncOnce(at(0));
    fake.setJob((await jobOf(a.id)).fornaxJobId!, succeeded({ ...TRANSCRIPT, segments: [{ start_ms: 5, end_ms: 1, text: 'x' }] }));
    await sync.syncOnce(at(1000));
    expect(await jobOf(a.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/^the transcript from Fornax could not be stored: segment 0/) });
    expect(await db.select().from(reportTranscripts)).toEqual([]);
  });

  it('keeps a finished job when its transcript cannot be fetched yet, and stores it later', async () => {
    const a = await recording();
    const sync = newSync();
    await sync.syncOnce(at(0));
    const id = (await jobOf(a.id)).fornaxJobId!;
    fake.setJob(id, succeeded());
    fake.fail(`/api/jobs/${id}/outputs/transcript.json`, 503);
    await sync.syncOnce(at(1000));
    expect((await jobOf(a.id)).status).toBe('queued');
    fake.fail(`/api/jobs/${id}/outputs/transcript.json`, null);
    await sync.syncOnce(at(2000));
    expect((await jobOf(a.id)).status).toBe('done');
  });

  it('fails with the reason when Fornax failed, canceled or forgot the job', async () => {
    const failed = await recording();
    const canceled = await recording();
    const forgotten = await recording();
    const sync = newSync();
    await sync.syncOnce(at(0));
    fake.setJob((await jobOf(failed.id)).fornaxJobId!, { state: 'failed', error: 'ffmpeg could not read the input' });
    fake.setJob((await jobOf(canceled.id)).fornaxJobId!, { state: 'canceled' });
    fake.jobs.delete((await jobOf(forgotten.id)).fornaxJobId!);
    await sync.syncOnce(at(1000));
    expect(await jobOf(failed.id)).toMatchObject({ status: 'failed', error: 'ffmpeg could not read the input', finishedAt: at(1000) });
    expect(await jobOf(canceled.id)).toMatchObject({ status: 'failed', error: FORNAX_CANCELED });
    expect(FORNAX_CANCELED).toBe('the job was canceled in Fornax');
    expect(await jobOf(forgotten.id)).toMatchObject({ status: 'failed', error: FORNAX_FORGOT });
    expect(FORNAX_FORGOT).toBe('Fornax no longer knows this job');
  });

  it('keeps following through a 404 that is not from Fornax (a proxy while Fornax restarts)', async () => {
    const a = await recording();
    const sync = newSync();
    await sync.syncOnce(at(0));
    const id = (await jobOf(a.id)).fornaxJobId!;
    fake.fail(`/api/jobs/${id}`, 'proxy-404');
    await sync.syncOnce(at(1000));
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', error: null, fornaxJobId: id });
    fake.fail(`/api/jobs/${id}`, null);
    fake.setJob(id, succeeded());
    fake.fail(`/api/jobs/${id}/outputs/transcript.json`, 'proxy-404');
    await sync.syncOnce(at(2000));
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', error: null, fornaxJobId: id });
    fake.fail(`/api/jobs/${id}/outputs/transcript.json`, null);
    await sync.syncOnce(at(3000));
    expect((await jobOf(a.id)).status).toBe('done');
  });

  it('retries a failed upload or submit after 1 and 4 minutes and gives up after the third', async () => {
    expect(MAX_ATTEMPTS).toBe(3);
    const a = await recording();
    const sync = newSync();
    fake.fail('/api/files', 'network');
    await sync.syncOnce(at(0));
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', attempts: 1, submitting: false, runAfter: at(60_000), fornaxJobId: null });
    expect((await jobOf(a.id)).error).toMatch(/Fornax is unreachable/);
    expect(await stateOf(a.id, at(1000))).toMatchObject({ status: 'queued', retryAt: at(60_000).toISOString() });
    await sync.syncOnce(at(30_000));
    expect((await jobOf(a.id)).attempts).toBe(1);
    fake.fail('/api/files', null);
    fake.fail('/api/jobs', 500);
    await sync.syncOnce(at(60_000));
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', attempts: 2, runAfter: at(300_000), error: expect.stringMatching(/500/) });
    await sync.syncOnce(at(300_000));
    expect(await jobOf(a.id)).toMatchObject({ status: 'failed', attempts: 3, finishedAt: at(300_000), error: expect.stringMatching(/500/) });
    expect(fake.jobs.size).toBe(0);
  });

  it('keeps a recording waiting, without an attempt, while Fornax does not accept the token', async () => {
    const a = await recording();
    const sync = newSync();
    for (const how of ['pending', 403, 401] as const) {
      fake.fail('/api/files', how);
      await sync.syncOnce(at(0));
      const job = await jobOf(a.id);
      expect(job).toMatchObject({ status: 'queued', attempts: 0, submitting: false, runAfter: at(60_000), fornaxJobId: null, finishedAt: null });
      expect(job.note).toBe(how === 'pending' ? PENDING_MESSAGE : how === 403 ? 'injected failure 403' : 'injected failure 401');
      await sync.syncOnce(at(30_000));
      expect(fake.requests.filter((r) => r.path === '/api/files').length).toBe(['pending', 403, 401].indexOf(how) + 1);
      await db.update(reportJobs).set({ runAfter: at(0) }).where(eq(reportJobs.id, job.id));
    }
    // refused at the job creation, after a good upload
    fake.fail('/api/files', null);
    fake.fail('/api/jobs', 'pending');
    await sync.syncOnce(at(0));
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', attempts: 0, runAfter: at(60_000), note: PENDING_MESSAGE, fornaxJobId: null });
    // approved: the next tick submits and the note clears
    fake.fail('/api/jobs', null);
    await sync.syncOnce(at(60_000));
    const done = await jobOf(a.id);
    expect(done).toMatchObject({ status: 'queued', attempts: 1, error: null, fornaxJobId: expect.any(String) });
    expect(done.note).toBe((await fornaxJob(a.id)).note);
    expect(done.note).not.toBe(PENDING_MESSAGE);
  });

  it('never fails a followed job over a 401 or 403; the job keeps its state', async () => {
    const a = await recording();
    const sync = newSync();
    await sync.syncOnce(at(0));
    const id = (await jobOf(a.id)).fornaxJobId!;
    fake.setJob(id, { state: 'running' });
    await sync.syncOnce(at(1000));
    for (const how of ['pending', 403, 401] as const) {
      fake.fail(`/api/jobs/${id}`, how);
      await sync.syncOnce(at(2000));
      expect(await jobOf(a.id)).toMatchObject({ status: 'running', attempts: 1, error: null, fornaxJobId: id });
    }
    fake.fail(`/api/jobs/${id}`, null);
    fake.setJob(id, succeeded());
    await sync.syncOnce(at(3000));
    expect((await jobOf(a.id)).status).toBe('done');
  });

  it('shows the pending message as the note of a waiting followed job', async () => {
    const a = await recording();
    const sync = newSync();
    await sync.syncOnce(at(0));
    const id = (await jobOf(a.id)).fornaxJobId!;
    fake.fail(`/api/jobs/${id}`, 'pending');
    await sync.syncOnce(at(1000));
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', note: PENDING_MESSAGE });
    fake.fail(`/api/jobs/${id}`, null);
    await sync.syncOnce(at(2000));
    expect((await jobOf(a.id)).note).toBe((await fornaxJob(a.id)).note);
  });

  it('fails at once when Fornax refuses the job (4xx), with its message', async () => {
    const offered = await recording();
    fake.worker.offered = false;
    const sync = newSync();
    await sync.syncOnce(at(0));
    expect(await jobOf(offered.id)).toMatchObject({ status: 'failed', attempts: 1, error: expect.stringMatching(/is not offered now/) });
    fake.worker.offered = true;
    const bad = await recording();
    fake.fail('/api/jobs', 400);
    await sync.syncOnce(at(1000));
    expect(await jobOf(bad.id)).toMatchObject({ status: 'failed', attempts: 1, error: expect.stringMatching(/injected failure 400/) });
  });

  it('keeps following when Fornax cannot be reached, without counting an attempt', async () => {
    const a = await recording();
    const sync = newSync();
    await sync.syncOnce(at(0));
    const id = (await jobOf(a.id)).fornaxJobId!;
    fake.fail(`/api/jobs/${id}`, 'network');
    await sync.syncOnce(at(1000));
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', attempts: 1, error: null, fornaxJobId: id });
    fake.fail(`/api/jobs/${id}`, null);
    fake.setJob(id, { state: 'running' });
    await sync.syncOnce(at(2000));
    fake.fail(`/api/jobs/${id}`, 502);
    await sync.syncOnce(at(3000));
    expect(await jobOf(a.id)).toMatchObject({ status: 'running', attempts: 1, error: null });
    fake.fail(`/api/jobs/${id}`, null);
    fake.setJob(id, succeeded());
    await sync.syncOnce(at(4000));
    expect((await jobOf(a.id)).status).toBe('done');
  });

  it('submits a job once even when two syncs run at the same time', async () => {
    const ids = [(await recording()).id, (await recording()).id, (await recording()).id];
    // Slow uploads: the other syncs look for work while a job's upload is still running.
    const slow: FornaxClient = {
      ...client,
      uploadFile: async (...args: Parameters<FornaxClient['uploadFile']>) => {
        await new Promise((r) => setTimeout(r, 150));
        return client.uploadFile(...args);
      },
    };
    const one = newSync(slow);
    const two = newSync(slow);
    await Promise.all([one.syncOnce(at(0)), two.syncOnce(at(0)), one.syncOnce(at(0)), two.syncOnce(at(0))]);
    expect(fake.jobs.size).toBe(3);
    expect(fake.files.size).toBe(3);
    for (const id of ids) expect(await jobOf(id)).toMatchObject({ attempts: 1, submitting: false, fornaxJobId: expect.any(String) });
  });

  it('fails a recording whose file is gone, and does not revive a job whose recording was deleted', async () => {
    const missing = await recording();
    await store.remove(missing.storageKey);
    const purged = await recording();
    const sync = newSync();
    await sync.syncOnce(at(0));
    expect(await jobOf(missing.id)).toMatchObject({ status: 'failed', error: MEDIA_GONE, fornaxJobId: null });

    const id = (await jobOf(purged.id)).fornaxJobId!;
    await failPendingJobs(db, [purged.id], at(500));
    fake.setJob(id, succeeded());
    await sync.syncOnce(at(1000));
    expect(await jobOf(purged.id)).toMatchObject({ status: 'failed', error: MEDIA_GONE, finishedAt: at(500) });
    expect(await db.select().from(reportTranscripts)).toEqual([]);
  });

  it('lets a new sync finish the jobs an earlier one submitted', async () => {
    const a = await recording();
    await newSync().syncOnce(at(0));
    fake.setJob((await jobOf(a.id)).fornaxJobId!, succeeded());
    await newSync().syncOnce(at(1000));
    expect((await jobOf(a.id)).status).toBe('done');
  });

  it('starts over with a new upload and job on Try again and Transcribe again; the old transcript stays until the new one is in', async () => {
    const a = await recording();
    const sync = newSync();
    await sync.syncOnce(at(0));
    const first = (await jobOf(a.id)).fornaxJobId!;
    fake.setJob(first, { state: 'failed', error: 'CUDA out of memory' });
    await sync.syncOnce(at(1000));
    await retryTranscription(db, a.id, at(2000));
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', attempts: 0, error: null, fornaxJobId: null, fornaxChange: null, note: null });
    await sync.syncOnce(at(2000));
    const second = (await jobOf(a.id)).fornaxJobId!;
    expect(second).not.toBe(first);
    expect(fake.files.size).toBe(2);
    fake.setJob(second, succeeded());
    await sync.syncOnce(at(3000));
    expect((await jobOf(a.id)).status).toBe('done');

    await transcribeAgain(db, a.id, at(4000));
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', attempts: 0, fornaxJobId: null, fornaxChange: null, note: null });
    await sync.syncOnce(at(4000));
    const third = (await jobOf(a.id)).fornaxJobId!;
    expect(new Set([first, second, third]).size).toBe(3);
    expect(fake.files.size).toBe(3);
    // The old job finishing late changes nothing.
    fake.setJob(second, { state: 'failed', error: 'late' });
    expect(await stateOf(a.id)).toMatchObject({ status: 'done', segments: [{ text: 'Prehrávač zamrzne.' }, {}], again: { status: 'queued' } });
    fake.setJob(third, succeeded({ ...TRANSCRIPT, segments: [{ start_ms: 0, end_ms: 900, text: 'Nový prepis.' }], diarization: { model: 'pyannote/x', speakers: 0 } }));
    await sync.syncOnce(at(5000));
    expect(await stateOf(a.id)).toMatchObject({ status: 'done', segments: [{ text: 'Nový prepis.' }], again: null });
  });
});

describe('the running Fornax sync', () => {
  const fast = { tickMs: 50, retryMs: 50, waitS: 1 };

  it('submits new recordings, follows them with long polls and stores the transcript', async () => {
    const sync = newSync(client, fast);
    sync.start();
    const a = await recording();
    await vi.waitFor(async () => expect((await jobOf(a.id)).fornaxJobId).not.toBeNull(), { timeout: 5000 });
    const id = (await jobOf(a.id)).fornaxJobId!;
    fake.setJob(id, { state: 'running' });
    await vi.waitFor(async () => expect((await jobOf(a.id)).status).toBe('running'), { timeout: 5000 });
    fake.setJob(id, succeeded());
    await vi.waitFor(async () => expect((await jobOf(a.id)).status).toBe('done'), { timeout: 5000 });
    expect(fake.requests.some((r) => r.path === `/api/jobs/${id}` && /wait=1/.test(r.query))).toBe(true);
  });

  it('picks up a note-only change when the long poll times out', async () => {
    const a = await recording();
    await newSync().syncOnce(at(0));
    const sync = newSync(client, fast);
    sync.start();
    await vi.waitFor(() => expect(fake.requests.some((r) => /wait=1/.test(r.query))).toBe(true), { timeout: 5000 });
    fake.setJob((await jobOf(a.id)).fornaxJobId!, { note: 'the queue is paused' }, { sameChange: true });
    await vi.waitFor(async () => expect((await jobOf(a.id)).note).toBe('the queue is paused'), { timeout: 5000 });
  });

  it('logs a failing long poll once, and again when it works', async () => {
    const a = await recording();
    await newSync().syncOnce(at(0));
    const id = (await jobOf(a.id)).fornaxJobId!;
    const polls = () => fake.requests.filter((r) => r.path === `/api/jobs/${id}`).length;
    const lines = (level: string, text: RegExp) => logged.filter((l) => l.level === level && text.test(l.msg)).length;
    fake.fail(`/api/jobs/${id}`, 503);
    const sync = newSync(client, fast);
    sync.start();
    await vi.waitFor(() => expect(polls()).toBeGreaterThanOrEqual(5), { timeout: 5000 });
    expect(lines('warn', /could not follow a transcription/)).toBe(1);
    expect(lines('info', /works again/)).toBe(0);
    fake.fail(`/api/jobs/${id}`, null);
    await vi.waitFor(() => expect(lines('info', /works again/)).toBe(1), { timeout: 5000 });
    fake.fail(`/api/jobs/${id}`, 'network');
    fake.setJob(id, { note: 'waiting: the queue is paused' });
    await vi.waitFor(() => expect(lines('warn', /could not follow a transcription/)).toBe(2), { timeout: 5000 });
    fake.fail(`/api/jobs/${id}`, null);
    fake.setJob(id, succeeded());
    await vi.waitFor(async () => expect((await jobOf(a.id)).status).toBe('done'), { timeout: 5000 });
    expect(lines('warn', /could not follow a transcription/)).toBe(2);
    expect(lines('info', /works again/)).toBe(2);
  });

  it('follows other jobs while an upload hangs, and gives the job back when stopped', async () => {
    const followed = await recording();
    await newSync().syncOnce(at(0));
    const hanging = await recording();
    let uploads = 0;
    // The second upload never finishes on its own: it ends only when the sync stops.
    const slow: FornaxClient = {
      ...client,
      uploadFile: (name: string, body: Readable | ReadableStream, size: number, signal?: AbortSignal) => {
        uploads++;
        return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    };
    const sync = newSync(slow, fast);
    sync.start();
    await vi.waitFor(() => expect(uploads).toBe(1), { timeout: 5000 });
    expect((await jobOf(hanging.id)).submitting).toBe(true);
    fake.setJob((await jobOf(followed.id)).fornaxJobId!, succeeded());
    await vi.waitFor(async () => expect((await jobOf(followed.id)).status).toBe('done'), { timeout: 5000 });
    const t = Date.now();
    await sync.stop();
    expect(Date.now() - t).toBeLessThan(3000);
    expect(await jobOf(hanging.id)).toMatchObject({ status: 'queued', submitting: false, attempts: 0, fornaxJobId: null });
  });

  it('takes back a submit a stopped server left half done, and stops its long polls at once', async () => {
    const a = await recording();
    await db.update(reportJobs).set({ submitting: true }).where(eq(reportJobs.attachmentId, a.id));
    const b = await recording();
    await newSync().syncOnce(at(0));
    expect((await jobOf(a.id)).fornaxJobId).toBeNull();
    const sync = newSync(client, { ...fast, waitS: 25 });
    sync.start();
    await vi.waitFor(async () => expect((await jobOf(a.id)).fornaxJobId).not.toBeNull(), { timeout: 5000 });
    // b is followed with a 25 s long poll that has nothing to report.
    await vi.waitFor(() => expect(fake.requests.some((r) => r.path.startsWith('/api/jobs/') && /wait=25/.test(r.query))).toBe(true), { timeout: 5000 });
    const t = Date.now();
    await sync.stop();
    expect(Date.now() - t).toBeLessThan(3000);
    expect((await jobOf(b.id)).status).toBe('queued');
  });
});

const PDF = Buffer.from(`%PDF-1.7\n${' '.repeat(64)}`);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A report of Apollo with a PDF (or DOCX) document on disk, queued for reading in Fornax. */
async function parsing(opts: { body?: Buffer; ext?: 'pdf' | 'docx'; queue?: boolean } = {}) {
  const ext = opts.ext ?? 'pdf';
  const body = opts.body ?? PDF;
  const [r] = await db.insert(reports).values({ projectId: 'apollo', title: 'Contract', source: 'human', editedBy: 'human' }).returning();
  const id = randomUUID();
  const storageKey = `${r!.id}/${id}.${ext}`;
  await store.writeBuffer(storageKey, body);
  const [a] = await db
    .insert(reportAttachments)
    .values({
      id, reportId: r!.id, kind: 'document', mime: ext === 'pdf' ? 'application/pdf' : DOCX_MIME, size: body.length, sha256: 'x',
      fileName: `contract.${ext}`, storageKey, createdBy: 'human',
    })
    .returning();
  if (opts.queue !== false) await enqueueParse(db, id);
  return a!;
}

/** The meta of document.md as Fornax sends it. */
const META = { path: 'text', kind: 'md', pages: 0, tables: 1, characters: 736, seconds: 20.4, peak_vram_mib: 0, docling: '2.151.1' };
type FakeOutputs = Array<{ name: string; kind: string; size: number; meta?: Record<string, unknown> }> | null;
const parsed = (md: string, outputs: FakeOutputs = [{ name: 'document.md', kind: 'file', size: md.length, meta: META }]) => ({
  state: 'succeeded' as const, files: new Map<string, unknown>([['document.md', md]]), outputs,
});

describe('the Fornax sync with documents', () => {
  it('uploads a queued document as document-parse with ocr auto, the priority and the group', async () => {
    const d = await parsing();
    const docx = await parsing({ ext: 'docx' });
    await newSync().syncOnce(at(0));
    const fj = await fornaxJob(d.id);
    expect(fj).toMatchObject({ type: 'document-parse', params: { ocr: 'auto' }, priority: 'high', group: 'tabula' });
    expect(Object.keys(fj.inputs)).toEqual(['document']);
    const file = fake.files.get(fj.inputs.document!)!;
    expect(file.name).toMatch(/\.pdf$/);
    expect(file.body.equals(PDF)).toBe(true);
    expect(fake.files.get((await fornaxJob(docx.id)).inputs.document!)!.name).toMatch(/\.docx$/);
    expect(await jobOf(d.id)).toMatchObject({ kind: 'parse', status: 'queued', attempts: 1, submitting: false, error: null });
    expect(logged.filter((l) => l.msg === 'submitted a document to Fornax')).toHaveLength(2);
  });

  it('stores the text of document.md with pages, tables and the model, and never logs the text', async () => {
    const d = await parsing();
    const sync = newSync();
    await sync.syncOnce(at(0));
    fake.setJob((await jobOf(d.id)).fornaxJobId!, parsed('# Zmluva\n\n| a | b |\n'));
    await sync.syncOnce(at(1000));
    expect(await getDocumentText(db, d.id)).toMatchObject({
      text: '# Zmluva\n\n| a | b |\n', source: 'fornax', model: 'docling 2.151.1', pages: 0, tables: 1, truncated: false, characters: 20,
    });
    expect(await jobOf(d.id)).toMatchObject({ status: 'done', error: null, note: null, finishedAt: at(1000) });
    expect(logged.find((l) => l.msg === 'stored the text of a document from Fornax')?.obj).toMatchObject({ characters: 20 });
    expect(JSON.stringify(logged)).not.toContain('Zmluva');
  });

  it('stores the text without pages, tables and model when the meta is missing or malformed', async () => {
    const noOutputs = await parsing();
    const malformed = await parsing();
    const otherOutput = await parsing();
    const outOfRange = await parsing();
    const sync = newSync();
    await sync.syncOnce(at(0));
    fake.setJob((await jobOf(noOutputs.id)).fornaxJobId!, parsed('a', null));
    fake.setJob(
      (await jobOf(malformed.id)).fornaxJobId!,
      parsed('b', [{ name: 'document.md', kind: 'file', size: 1, meta: { pages: '3', tables: -1, docling: 5 } }]),
    );
    fake.setJob((await jobOf(otherOutput.id)).fornaxJobId!, parsed('c', [{ name: 'log.txt', kind: 'file', size: 1, meta: META }]));
    fake.setJob(
      (await jobOf(outOfRange.id)).fornaxJobId!,
      parsed('d', [{ name: 'document.md', kind: 'file', size: 1, meta: { pages: 1.5, tables: 2 ** 31, docling: `2.1${String.fromCharCode(10)}` } }]),
    );
    await sync.syncOnce(at(1000));
    for (const [d, text] of [[noOutputs, 'a'], [malformed, 'b'], [otherOutput, 'c'], [outOfRange, 'd']] as const) {
      expect(await getDocumentText(db, d.id)).toMatchObject({ text, source: 'fornax', model: null, pages: null, tables: null });
      expect((await jobOf(d.id)).status).toBe('done');
    }
  });

  it('stores an empty text as done with 0 characters, and a text over the limit cut and marked', async () => {
    const empty = await parsing();
    const long = await parsing();
    const sync = newSync();
    await sync.syncOnce(at(0));
    fake.setJob((await jobOf(empty.id)).fornaxJobId!, parsed(''));
    fake.setJob((await jobOf(long.id)).fornaxJobId!, parsed('line\n'.repeat(250_000)));
    await sync.syncOnce(at(1000));
    expect(await getDocumentText(db, empty.id)).toMatchObject({ text: '', characters: 0, truncated: false });
    expect((await jobOf(empty.id)).status).toBe('done');
    const cut = (await getDocumentText(db, long.id))!;
    expect(cut.truncated).toBe(true);
    expect(cut.characters).toBeLessThanOrEqual(1_000_000);
    expect(cut.characters).toBe(cut.text.length);
    expect(cut.text.endsWith('line')).toBe(true);
    expect((await jobOf(long.id)).status).toBe('done');
  });

  it('reads only the first 4 MB of a larger document.md: stored cut and marked, and not fetched again', async () => {
    const d = await parsing();
    const sync = newSync();
    await sync.syncOnce(at(0));
    const id = (await jobOf(d.id)).fornaxJobId!;
    const chunk = Buffer.from('line\n'.repeat(13_107)); // 65 535 bytes
    // 8 MB of lines, then the connection breaks off: a reader that stops at 4 MB never reaches the break.
    async function* huge() {
      for (let i = 0; i < 128; i++) yield chunk;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      throw new Error('connection lost');
    }
    fake.setJob(id, {
      state: 'succeeded', files: new Map<string, unknown>([['document.md', huge]]),
      outputs: [{ name: 'document.md', kind: 'file', size: chunk.length * 128, meta: META }],
    });
    await sync.syncOnce(at(1000));
    const cut = (await getDocumentText(db, d.id))!;
    expect(cut).toMatchObject({ truncated: true, source: 'fornax', pages: 0, tables: 1 });
    expect(cut.characters).toBeLessThanOrEqual(1_000_000);
    expect(cut.characters).toBe(cut.text.length);
    expect(cut.text.endsWith('line')).toBe(true);
    expect(await jobOf(d.id)).toMatchObject({ status: 'done', error: null });
    await sync.syncOnce(at(2000));
    expect(fake.requests.filter((r) => r.path === `/api/jobs/${id}/outputs/document.md`)).toHaveLength(1);
  });

  it('fails a document larger than Fornax takes without uploading it', async () => {
    fake.parseMaxMb = 1 / 1024; // 1 KB
    const d = await parsing({ body: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x20)]) });
    await newSync().syncOnce(at(0));
    expect(await jobOf(d.id)).toMatchObject({
      status: 'failed', submitting: false, attempts: 0, finishedAt: at(0), error: expect.stringMatching(/^the document is larger than Fornax takes \(/),
    });
    expect((await jobOf(d.id)).error).toBe(`the document is larger than Fornax takes (${1 / 1024} MB)`);
    expect(fake.files.size).toBe(0);
    expect(fake.jobs.size).toBe(0);
  });

  it('uploads the document when the size limit cannot be read', async () => {
    const d = await parsing();
    fake.fail('/api/types', 503);
    await newSync().syncOnce(at(0));
    expect(await jobOf(d.id)).toMatchObject({ status: 'queued', fornaxJobId: expect.any(String) });
    expect(fake.files.size).toBe(1);
  });

  it('gives the document back without an attempt when stopped while asking for the size limit', async () => {
    const d = await parsing();
    let asked = 0;
    // The size limit never comes on its own: the call ends only when the sync stops.
    const hanging: FornaxClient = {
      ...client,
      inputLimitMb: (_type: string, _input: string, signal?: AbortSignal) => {
        asked++;
        return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    };
    const sync = newSync(hanging, { tickMs: 50, retryMs: 50, waitS: 1 });
    sync.start();
    await vi.waitFor(() => expect(asked).toBe(1), { timeout: 5000 });
    const t = Date.now();
    await sync.stop();
    expect(Date.now() - t).toBeLessThan(3000);
    expect(await jobOf(d.id)).toMatchObject({ status: 'queued', submitting: false, attempts: 0, fornaxJobId: null, error: null });
    expect(fake.files.size).toBe(0);
    expect(logged.filter((l) => l.level !== 'info')).toEqual([]);
  });

  it('speaks of the document when its file is gone or its text cannot be fetched', async () => {
    const missing = await parsing();
    await store.remove(missing.storageKey);
    const unfetched = await parsing();
    const sync = newSync();
    await sync.syncOnce(at(0));
    expect(await jobOf(missing.id)).toMatchObject({ status: 'failed', error: DOCUMENT_GONE, fornaxJobId: null });
    expect(DOCUMENT_GONE).toBe('the document was deleted before it was read');

    fake.setJob((await jobOf(unfetched.id)).fornaxJobId!, { state: 'succeeded', files: new Map(), outputs: [] });
    await sync.syncOnce(at(1000));
    expect(await jobOf(unfetched.id)).toMatchObject({
      status: 'failed', error: expect.stringMatching(/^the text of the document could not be fetched from Fornax: /),
    });
    expect(await getDocumentText(db, unfetched.id)).toBeUndefined();
  });

  it('says when the document file could not be read', async () => {
    const d = await parsing();
    // A directory in place of the file: stat works, reading fails.
    await store.remove(d.storageKey);
    mkdirSync(store.path(d.storageKey));
    const reading: FornaxClient = {
      ...client,
      uploadFile: async (_name: string, body: Readable | ReadableStream) => {
        try {
          for await (const _chunk of body as Readable) {
            // drain
          }
        } catch {
          throw new FornaxError('Fornax is unreachable', null, false);
        }
        throw new Error('the directory was read');
      },
    };
    await newSync(reading).syncOnce(at(0));
    const job = await jobOf(d.id);
    expect(job).toMatchObject({ status: 'queued', attempts: 1, runAfter: at(60_000) });
    expect(job.error).toMatch(/^the document file could not be read \(E[A-Z]+\)$/);
    expect(logged.some((l) => l.msg === 'could not submit a document to Fornax; trying again later')).toBe(true);
  });

  it('keeps a finished document when its text cannot be fetched yet, and stores it later', async () => {
    const d = await parsing();
    const sync = newSync();
    await sync.syncOnce(at(0));
    const id = (await jobOf(d.id)).fornaxJobId!;
    fake.setJob(id, parsed('text'));
    fake.fail(`/api/jobs/${id}/outputs/document.md`, 503);
    await sync.syncOnce(at(1000));
    expect((await jobOf(d.id)).status).toBe('queued');
    expect(logged.some((l) => l.msg === 'could not follow the reading of a document in Fornax; asking again later')).toBe(true);
    fake.fail(`/api/jobs/${id}/outputs/document.md`, null);
    await sync.syncOnce(at(2000));
    expect((await jobOf(d.id)).status).toBe('done');
  });

  it('does not store a text for a document deleted meanwhile', async () => {
    const d = await parsing();
    const sync = newSync();
    await sync.syncOnce(at(0));
    const id = (await jobOf(d.id)).fornaxJobId!;
    await failPendingJobs(db, [d.id], at(500));
    fake.setJob(id, parsed('text'));
    await sync.syncOnce(at(1000));
    expect(await jobOf(d.id)).toMatchObject({ status: 'failed', error: DOCUMENT_GONE, finishedAt: at(500) });
    expect(await db.select().from(reportDocuments)).toEqual([]);
  });

  it('keeps recordings and documents apart in one queue', async () => {
    const rec = await recording();
    const d = await parsing();
    const sync = newSync();
    await sync.syncOnce(at(0));
    expect((await fornaxJob(rec.id)).type).toBe('transcribe');
    expect((await fornaxJob(d.id)).type).toBe('document-parse');
    fake.setJob((await jobOf(rec.id)).fornaxJobId!, succeeded());
    fake.setJob((await jobOf(d.id)).fornaxJobId!, parsed('text'));
    await sync.syncOnce(at(1000));
    expect(await db.select().from(reportTranscripts)).toHaveLength(1);
    expect(await getDocumentText(db, d.id)).toMatchObject({ text: 'text' });
    expect(await getDocumentText(db, rec.id)).toBeUndefined();
    expect(await jobOf(rec.id)).toMatchObject({ kind: 'transcribe', status: 'done' });
    expect(await jobOf(d.id)).toMatchObject({ kind: 'parse', status: 'done' });
  });

  it('starts over with a new upload and job on Try again of a failed document', async () => {
    const d = await parsing();
    const sync = newSync();
    await sync.syncOnce(at(0));
    const first = (await jobOf(d.id)).fornaxJobId!;
    fake.setJob(first, { state: 'failed', error: 'docling could not open the file' });
    await sync.syncOnce(at(1000));
    expect(await jobOf(d.id)).toMatchObject({ status: 'failed', error: 'docling could not open the file', finishedAt: at(1000) });
    await retryDocument(db, store, d.id, { fornax: true }, at(2000));
    expect(await jobOf(d.id)).toMatchObject({ status: 'queued', attempts: 0, error: null, fornaxJobId: null, fornaxChange: null, note: null });
    await sync.syncOnce(at(2000));
    const second = (await jobOf(d.id)).fornaxJobId!;
    expect(second).not.toBe(first);
    expect(fake.files.size).toBe(2);
    expect(fake.jobs.get(second)!.type).toBe('document-parse');
    fake.setJob(second, parsed('text'));
    await sync.syncOnce(at(3000));
    expect(await jobOf(d.id)).toMatchObject({ status: 'done' });
    expect(await getDocumentText(db, d.id)).toMatchObject({ text: 'text' });
  });
});

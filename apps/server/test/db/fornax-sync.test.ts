import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projects, reportAttachments, reportJobs, reports, reportTranscripts } from '../../src/db/schema.js';
import {
  enqueueTranscription, failPendingJobs, MAX_ATTEMPTS, MEDIA_GONE, retryTranscription, transcribeAgain, transcriptStates,
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

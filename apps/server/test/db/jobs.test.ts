import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { reportAttachments, reportJobs, reports } from '../../src/db/schema.js';
import {
  enqueueTranscription, failPendingJobs, MEDIA_GONE, retryDelayMs, retryTranscription, storeTranscript, transcribeAgain, transcriptionStatus,
  transcriptStates,
} from '../../src/domain/jobs.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
beforeEach(() => seedProject(db, 'demo'));

type Opts = { kind?: 'audio' | 'video' | 'image'; durationMs?: number | null; purged?: boolean; closed?: boolean };

/** A report with one attachment, written straight to the database (no files needed). */
async function recording(opts: Opts = {}) {
  const kind = opts.kind ?? 'audio';
  const [r] = await db
    .insert(reports)
    .values({
      projectId: 'demo', title: 'Player freezes', source: 'human', editedBy: 'human',
      ...(opts.closed ? { status: 'done' as const, closedAt: new Date() } : {}),
    })
    .returning();
  const id = randomUUID();
  const [a] = await db
    .insert(reportAttachments)
    .values({
      id, reportId: r!.id, kind, mime: kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/wav' : 'video/mp4', size: 10,
      sha256: 'x', fileName: 'rec', storageKey: `${r!.id}/${id}.bin`, durationMs: opts.durationMs ?? null, createdBy: 'human',
      purgedAt: opts.purged ? new Date() : null,
    })
    .returning();
  return a!;
}

async function queued(opts?: Opts) {
  const a = await recording(opts);
  await enqueueTranscription(db, a.id);
  return a;
}

const jobOf = async (attachmentId: string) => (await db.select().from(reportJobs).where(eq(reportJobs.attachmentId, attachmentId)))[0]!;
const setJob = (attachmentId: string, values: Partial<typeof reportJobs.$inferInsert>) =>
  db.update(reportJobs).set(values).where(eq(reportJobs.attachmentId, attachmentId));
const SEGMENTS = [{ start_ms: 0, end_ms: 1200, text: ' Prehrávač zamrzne. ' }];
const store = (attachmentId: string, input: Parameters<typeof storeTranscript>[2], now?: Date) =>
  db.transaction(async (tx) => storeTranscript(tx, (await jobOf(attachmentId)).id, input, now));
/** A job as the sync leaves it while Fornax works on it. */
const IN_FORNAX = { status: 'running' as const, attempts: 1, fornaxJobId: 'j_1', fornaxChange: 'c1', note: 'waiting', submitting: false };

describe('transcription jobs', () => {
  it('queues a recording once', async () => {
    const a = await queued();
    await enqueueTranscription(db, a.id);
    expect(await db.select().from(reportJobs)).toHaveLength(1);
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', attempts: 0, fornaxJobId: null, fornaxChange: null, note: null, submitting: false });
  });

  it('waits 1 minute after the first failed submit and 4 after the second', () => {
    expect([retryDelayMs(1), retryDelayMs(2)]).toEqual([60_000, 240_000]);
  });

  it('stores the transcript, fills a missing duration only, and refuses a bad one', async () => {
    const a = await queued();
    const b = await queued({ durationMs: 5000 });
    const input = { language: 'sk', model: 'large-v3', durationMs: 4200, segments: SEGMENTS };
    await expect(store(a.id, { ...input, durationMs: -1 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(store(a.id, { ...input, language: 'sk; drop' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(store(a.id, { ...input, model: '' })).rejects.toMatchObject({ code: 'bad_request' });
    const now = new Date('2026-11-17T10:00:00Z');
    expect(await store(a.id, input, now)).toEqual({ segments: 1 });
    await store(b.id, { language: null, model: 'large-v3', durationMs: 4200, segments: [] });
    expect(await jobOf(a.id)).toMatchObject({ status: 'done', error: null, note: null, finishedAt: now });
    const duration = async (id: string) => (await db.select().from(reportAttachments).where(eq(reportAttachments.id, id)))[0]!.durationMs;
    expect(await duration(a.id)).toBe(4200);
    expect(await duration(b.id)).toBe(5000);
    const states = await transcriptStates(db, [a.id, b.id]);
    expect(states.get(a.id)).toMatchObject({
      status: 'done', language: 'sk', model: 'large-v3', segments: [{ start_ms: 0, end_ms: 1200, text: 'Prehrávač zamrzne.' }],
    });
    expect(states.get(b.id)).toMatchObject({ status: 'done', language: null, segments: [] });
    await expect(db.transaction((tx) => storeTranscript(tx, randomUUID(), input))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lets the user retry a failed transcription from the start, or start one that was never queued', async () => {
    const a = await queued();
    await setJob(a.id, { ...IN_FORNAX, status: 'failed', error: 'CUDA out of memory', finishedAt: new Date() });
    await retryTranscription(db, a.id);
    expect(await jobOf(a.id)).toMatchObject({
      status: 'queued', attempts: 0, error: null, fornaxJobId: null, fornaxChange: null, note: null, submitting: false, finishedAt: null,
    });
    await expect(retryTranscription(db, a.id)).rejects.toMatchObject({ code: 'conflict' });
    await setJob(a.id, IN_FORNAX);
    await expect(retryTranscription(db, a.id)).rejects.toMatchObject({ code: 'conflict' });
    const never = await recording({ kind: 'video' });
    await retryTranscription(db, never.id);
    expect((await jobOf(never.id)).status).toBe('queued');
    await expect(retryTranscription(db, (await recording({ kind: 'image' })).id)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(retryTranscription(db, (await recording({ purged: true })).id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(retryTranscription(db, randomUUID())).rejects.toMatchObject({ code: 'not_found' });
  });

  it('transcribes a done recording again from the start, but not while Fornax works on it', async () => {
    const a = await queued();
    await store(a.id, { language: 'sk', model: 'large-v3', durationMs: null, segments: SEGMENTS });
    await setJob(a.id, { fornaxJobId: 'j_1', fornaxChange: 'c9' });
    await transcribeAgain(db, a.id);
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', attempts: 0, fornaxJobId: null, fornaxChange: null, note: null, submitting: false });
    await expect(transcribeAgain(db, a.id)).rejects.toMatchObject({ code: 'conflict' });
    await setJob(a.id, IN_FORNAX);
    await expect(transcribeAgain(db, a.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(await transcriptStates(db, [a.id]).then((m) => m.get(a.id))).toMatchObject({ status: 'done', again: { status: 'running' } });
  });

  it('fails the jobs of recordings deleted before Fornax finished them, and leaves done ones alone', async () => {
    const waiting = await queued();
    const inFornax = await queued();
    await setJob(inFornax.id, IN_FORNAX);
    const done = await queued();
    await setJob(done.id, { status: 'done' });
    const now = new Date('2026-11-17T10:00:00Z');
    await failPendingJobs(db, [waiting.id, inFornax.id, done.id], now);
    expect(await jobOf(waiting.id)).toMatchObject({ status: 'failed', error: MEDIA_GONE, finishedAt: now, submitting: false });
    expect(await jobOf(inFornax.id)).toMatchObject({ status: 'failed', error: MEDIA_GONE, note: null });
    expect((await jobOf(done.id)).status).toBe('done');
  });

  it('tells why a job waits: the note from Fornax, the back-off and the last error', async () => {
    const a = await queued();
    const now = new Date(Date.now() + 60_000);
    expect((await transcriptStates(db, [a.id], now)).get(a.id)).toEqual({ status: 'queued', attempts: 0, error: null, retryAt: null, note: null });
    await setJob(a.id, { ...IN_FORNAX, status: 'queued', note: 'the worker is offline' });
    expect((await transcriptStates(db, [a.id], now)).get(a.id)).toEqual({
      status: 'queued', attempts: 1, error: null, retryAt: null, note: 'the worker is offline',
    });
    const later = new Date(now.getTime() + 60_000);
    await setJob(a.id, { fornaxJobId: null, note: null, error: 'Fornax is unreachable', runAfter: later });
    expect((await transcriptStates(db, [a.id], now)).get(a.id)).toEqual({
      status: 'queued', attempts: 1, error: 'Fornax is unreachable', retryAt: later.toISOString(), note: null,
    });
    await setJob(a.id, { status: 'failed', error: 'boom' });
    expect((await transcriptStates(db, [a.id], now)).get(a.id)).toEqual({ status: 'failed', attempts: 1, error: 'boom', retryAt: null });
  });

  it('shows how far Fornax is with a running job, also while a done recording is transcribed again', async () => {
    const a = await queued();
    await setJob(a.id, { ...IN_FORNAX, note: null, progress: 42, progressMessage: 'transcribing 01:23 / 10:00' });
    expect((await transcriptStates(db, [a.id])).get(a.id)).toEqual({
      status: 'running', attempts: 1, error: null, retryAt: null, note: null, progress: 42, progressMessage: 'transcribing 01:23 / 10:00',
    });
    await store(a.id, { language: 'sk', model: 'large-v3', durationMs: null, segments: SEGMENTS });
    await transcribeAgain(db, a.id);
    expect(await jobOf(a.id)).toMatchObject({ progress: null, progressMessage: null });
    await setJob(a.id, { fornaxJobId: 'j_2', note: 'waiting: the worker is offline since 13:40' });
    expect((await transcriptStates(db, [a.id])).get(a.id)).toMatchObject({
      status: 'done',
      again: { status: 'queued', error: null, retryAt: null, note: 'waiting: the worker is offline since 13:40', progress: null, progressMessage: null },
    });
    await setJob(a.id, { status: 'running', note: null, progress: 7, progressMessage: 'extracting the audio' });
    expect((await transcriptStates(db, [a.id])).get(a.id)).toMatchObject({
      status: 'done', again: { status: 'running', note: null, progress: 7, progressMessage: 'extracting the audio' },
    });
  });

  it('counts the recordings of open reports that wait, run and failed', async () => {
    expect(await transcriptionStatus(db)).toEqual({ queued: 0, running: 0, failed: 0 });
    await queued();
    await queued({ closed: true });
    const r = await queued();
    await setJob(r.id, IN_FORNAX);
    expect(await transcriptionStatus(db)).toEqual({ queued: 1, running: 1, failed: 0 });
  });

  it('counts documents waiting for Fornax with the recordings', async () => {
    await queued();
    const [r] = await db.insert(reports).values({ projectId: 'demo', title: 'Minutes', source: 'human', editedBy: 'human' }).returning();
    const id = randomUUID();
    await db.insert(reportAttachments).values({
      id, reportId: r!.id, kind: 'document', mime: 'application/pdf', size: 10, sha256: 'x', fileName: 'minutes.pdf',
      storageKey: `${r!.id}/${id}.pdf`, createdBy: 'human',
    });
    await db.insert(reportJobs).values({ attachmentId: id, kind: 'parse' });
    await setJob(id, IN_FORNAX);
    expect(await transcriptionStatus(db)).toEqual({ queued: 1, running: 1, failed: 0 });
  });

  it('does not show the state of a document reading as a transcript', async () => {
    const a = await recording();
    await db.insert(reportJobs).values({ attachmentId: a.id, kind: 'parse' });
    expect((await transcriptStates(db, [a.id])).get(a.id)).toBeUndefined();
  });
});

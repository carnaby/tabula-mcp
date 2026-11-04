import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { reportAttachments, reportJobs, reports } from '../../src/db/schema.js';
import {
  claimJob, completeJob, enqueueTranscription, expireLeases, failJob, failPendingJobs, heartbeatJob, jobSignal, LEASE_EXPIRED,
  LEASE_MS, MEDIA_GONE, queuedCount, releaseJob, retryTranscription, touchWorker, transcriptionStatus, transcriptStates,
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
const SEGMENTS = [{ start_ms: 0, end_ms: 1200, text: ' Prehrávač zamrzne. ' }];
/**
 * The queue takes `now`, so tests travel in time. The base lies ten minutes ahead, after every row the tests insert
 * with the real clock (a claim "before" a job was queued would find nothing).
 */
const t0 = Date.now() + 10 * 60_000;
const at = (ms: number) => new Date(t0 + ms);

describe('transcription jobs', () => {
  it('queues a recording once and hands it out with its report', async () => {
    const a = await queued();
    await enqueueTranscription(db, a.id);
    expect(await queuedCount(db)).toBe(1);
    const c = await claimJob(db, 'studio-pc');
    expect(c).toMatchObject({
      job: { attachmentId: a.id, status: 'running', attempts: 1, worker: 'studio-pc' },
      attachment: { id: a.id },
      report: { projectId: 'demo', title: 'Player freezes' },
    });
    expect(c!.job.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(c!.job.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + LEASE_MS - 5000);
    expect(await claimJob(db, 'studio-pc')).toBeNull();
  });

  it('never waits for or doubles a job another claim holds (SKIP LOCKED)', async () => {
    const one = await queued();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM report_jobs WHERE attachment_id = ${one.id} FOR UPDATE`);
      // Without SKIP LOCKED this claim would wait for the transaction above, which waits for it: the test would time out.
      expect(await claimJob(db, 'b')).toBeNull();
    });
    const two = await queued();
    const [x, y] = await Promise.all([claimJob(db, 'a'), claimJob(db, 'b')]);
    expect(new Set([x!.job.attachmentId, y!.job.attachmentId])).toEqual(new Set([one.id, two.id]));
  });

  it('puts a job back when its lease runs out, and fails it after the third attempt', async () => {
    const a = await queued();
    const first = (await claimJob(db, 'a', at(0)))!;
    // The PC went to sleep: a claim after the lease finds the job again.
    const second = (await claimJob(db, 'b', at(LEASE_MS + 1000)))!;
    expect(second.job).toMatchObject({ id: first.job.id, attempts: 2, worker: 'b', error: LEASE_EXPIRED });
    await expect(heartbeatJob(db, first.job.id, first.job.leaseId!)).rejects.toMatchObject({ code: 'conflict' });
    expect((await claimJob(db, 'c', at(2 * LEASE_MS + 2000)))!.job.attempts).toBe(3);
    expect(await expireLeases(db, at(3 * LEASE_MS + 3000))).toBe(1);
    expect(await jobOf(a.id)).toMatchObject({ status: 'failed', attempts: 3, error: LEASE_EXPIRED });
  });

  it('lets a worker that woke up keep a job nobody else took', async () => {
    const a = await queued();
    const c = (await claimJob(db, 'a', at(0)))!;
    await expireLeases(db, at(LEASE_MS + 1000));
    expect((await jobOf(a.id)).status).toBe('queued');
    await heartbeatJob(db, c.job.id, c.job.leaseId!);
    expect(await jobOf(a.id)).toMatchObject({ status: 'running', attempts: 1, error: null });
    await completeJob(db, c.job.id, c.job.leaseId!, { language: 'sk', model: 'large-v3', durationMs: null, segments: SEGMENTS });
    expect((await jobOf(a.id)).status).toBe('done');
  });

  it('retries a failed job after a back-off, refunds a released one and gives up after three attempts', async () => {
    const a = await queued();
    let c = (await claimJob(db, 'a', at(0)))!;
    expect(await failJob(db, c.job.id, c.job.leaseId!, { error: 'ffmpeg\nexited\twith 1' }, at(0))).toEqual({ status: 'queued', retryAt: at(60_000) });
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', error: 'ffmpeg exited with 1', leaseId: null });
    expect((await transcriptStates(db, [a.id], at(1000))).get(a.id)).toEqual({
      status: 'queued', attempts: 1, error: 'ffmpeg exited with 1', retryAt: at(60_000).toISOString(),
    });
    expect(await claimJob(db, 'a', at(1000))).toBeNull();
    c = (await claimJob(db, 'a', at(61_000)))!;
    expect(c.job.attempts).toBe(2);
    // Stopped with Ctrl+C: not an attempt.
    await releaseJob(db, c.job.id, c.job.leaseId!, at(62_000));
    c = (await claimJob(db, 'a', at(62_000)))!;
    expect(c.job.attempts).toBe(2);
    expect(await failJob(db, c.job.id, c.job.leaseId!, { error: 'boom' }, at(62_000))).toEqual({ status: 'queued', retryAt: at(302_000) });
    c = (await claimJob(db, 'a', at(302_000)))!;
    expect(c.job.attempts).toBe(3);
    expect(await failJob(db, c.job.id, c.job.leaseId!, { error: 'boom again' }, at(303_000))).toEqual({ status: 'failed', retryAt: null });
    expect(await jobOf(a.id)).toMatchObject({ status: 'failed', error: 'boom again', leaseId: null, finishedAt: at(303_000) });
  });

  it('fails a job at once when the error is permanent', async () => {
    const a = await queued();
    const c = (await claimJob(db, 'a'))!;
    expect((await failJob(db, c.job.id, c.job.leaseId!, { error: 'the recording was deleted on the server', permanent: true })).status).toBe('failed');
    expect((await jobOf(a.id)).attempts).toBe(1);
  });

  it('stores the transcript, fills a missing duration only, and refuses a stale or finished lease', async () => {
    const a = await queued();
    const b = await queued({ durationMs: 5000 });
    const c1 = (await claimJob(db, 'w'))!;
    const c2 = (await claimJob(db, 'w'))!;
    const ca = c1.job.attachmentId === a.id ? c1 : c2;
    const cb = ca === c1 ? c2 : c1;
    const input = { language: 'sk', model: 'large-v3', durationMs: 4200, segments: SEGMENTS };
    await expect(completeJob(db, ca.job.id, randomUUID(), input)).rejects.toMatchObject({ code: 'conflict' });
    await expect(completeJob(db, ca.job.id, ca.job.leaseId!, { ...input, durationMs: -1 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(completeJob(db, ca.job.id, ca.job.leaseId!, { ...input, language: 'sk; drop' })).rejects.toMatchObject({ code: 'bad_request' });
    expect(await completeJob(db, ca.job.id, ca.job.leaseId!, input)).toEqual({ segments: 1 });
    await completeJob(db, cb.job.id, cb.job.leaseId!, { language: null, model: 'large-v3', durationMs: 4200, segments: [] });
    const duration = async (id: string) => (await db.select().from(reportAttachments).where(eq(reportAttachments.id, id)))[0]!.durationMs;
    expect(await duration(a.id)).toBe(4200);
    expect(await duration(b.id)).toBe(5000);
    const states = await transcriptStates(db, [a.id, b.id]);
    expect(states.get(a.id)).toMatchObject({
      status: 'done', language: 'sk', model: 'large-v3', segments: [{ start_ms: 0, end_ms: 1200, text: 'Prehrávač zamrzne.' }],
    });
    expect(states.get(b.id)).toMatchObject({ status: 'done', language: null, segments: [] });
    await expect(completeJob(db, ca.job.id, ca.job.leaseId!, input)).rejects.toMatchObject({ code: 'conflict' });
    await expect(heartbeatJob(db, randomUUID(), randomUUID())).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lets the user retry a failed transcription, or start one that was never queued', async () => {
    const a = await queued();
    const c = (await claimJob(db, 'w'))!;
    await failJob(db, c.job.id, c.job.leaseId!, { error: 'x', permanent: true });
    await retryTranscription(db, a.id);
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', attempts: 0, error: null, leaseId: null });
    await expect(retryTranscription(db, a.id)).rejects.toMatchObject({ code: 'conflict' });
    // A job whose lease ran out on its last attempt fails but keeps that lease (a late heartbeat could take it back).
    // The old worker's lease is gone with the retry.
    let held = (await claimJob(db, 'w', at(0)))!;
    held = (await claimJob(db, 'w', at(LEASE_MS + 1000)))!;
    held = (await claimJob(db, 'w', at(2 * LEASE_MS + 2000)))!;
    await expireLeases(db, at(3 * LEASE_MS + 3000));
    expect(await jobOf(a.id)).toMatchObject({ status: 'failed', attempts: 3, leaseId: held.job.leaseId });
    await retryTranscription(db, a.id);
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', attempts: 0, leaseId: null });
    await expect(heartbeatJob(db, held.job.id, held.job.leaseId!)).rejects.toMatchObject({ code: 'conflict' });
    const never = await recording({ kind: 'video' });
    await retryTranscription(db, never.id);
    expect((await jobOf(never.id)).status).toBe('queued');
    await expect(retryTranscription(db, (await recording({ kind: 'image' })).id)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(retryTranscription(db, (await recording({ purged: true })).id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(retryTranscription(db, randomUUID())).rejects.toMatchObject({ code: 'not_found' });
  });

  it('fails the jobs of recordings deleted before the worker got to them, and never hands those out', async () => {
    const a = await queued();
    await failPendingJobs(db, [a.id]);
    expect(await jobOf(a.id)).toMatchObject({ status: 'failed', error: MEDIA_GONE });
    const b = await queued();
    await db.update(reportAttachments).set({ purgedAt: new Date() }).where(eq(reportAttachments.id, b.id));
    expect(await claimJob(db, 'w')).toBeNull();
  });

  it('does not let a late heartbeat revive a job that failed and whose recording was then deleted', async () => {
    const a = await queued();
    const first = (await claimJob(db, 'w', at(0)))!;
    await claimJob(db, 'w', at(LEASE_MS + 1000));
    await claimJob(db, 'w', at(2 * LEASE_MS + 2000));
    expect(await expireLeases(db, at(3 * LEASE_MS + 3000))).toBe(1);
    const stuck = await jobOf(a.id);
    expect(stuck.status).toBe('failed');
    expect(stuck.leaseId).not.toBeNull();
    const lease = stuck.leaseId!;
    expect(first.job.leaseId).not.toBe(lease);
    await db.update(reportAttachments).set({ purgedAt: new Date() }).where(eq(reportAttachments.id, a.id));
    await failPendingJobs(db, [a.id], at(3 * LEASE_MS + 4000));
    await expect(heartbeatJob(db, stuck.id, lease, at(3 * LEASE_MS + 5000))).rejects.toMatchObject({ code: 'conflict' });
    expect(await jobOf(a.id)).toMatchObject({ status: 'failed', leaseId: null });
  });

  it('wakes a waiting claim when a recording is queued', async () => {
    const a = await recording();
    const started = Date.now();
    const waiting = jobSignal.wait(5000);
    await enqueueTranscription(db, a.id);
    await waiting;
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('knows when the worker was last seen and how many recordings of open reports wait', async () => {
    expect(await transcriptionStatus(db)).toEqual({ lastSeenAt: null, workers: [], queued: 0, running: 0, failed: 0 });
    await queued();
    await queued({ closed: true });
    await touchWorker(db, 'studio-pc', '1.2.0', new Date('2026-11-02T10:00:00Z'));
    await touchWorker(db, 'studio-pc', '1.2.0', new Date('2026-11-02T11:00:00Z'));
    expect(await transcriptionStatus(db)).toEqual({
      lastSeenAt: '2026-11-02T11:00:00.000Z',
      workers: [{ name: 'studio-pc', version: '1.2.0', lastSeenAt: '2026-11-02T11:00:00.000Z' }],
      queued: 1, running: 0, failed: 0,
    });
  });
});

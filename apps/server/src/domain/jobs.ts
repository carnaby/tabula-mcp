import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  type Diarization, reportAttachments, reportJobs, reports, reportTranscripts, type SpeakerNames, type TranscriptSegment, workers,
} from '../db/schema.js';
import { badRequest, conflict, notFound } from './errors.js';
import { cleanDiarization } from './speakers.js';
import { cleanSegments, type IncomingSegment, TRANSCRIPT_LIMITS, transcriptText } from './transcripts.js';

/** A worker holds a job this long without a heartbeat. */
export const LEASE_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
/** Wait before the next attempt after the n-th failed one: 1 minute, then 4. */
export const retryDelayMs = (attempts: number): number => 60_000 * 4 ** Math.max(0, attempts - 1);

export const LEASE_EXPIRED = 'the worker stopped answering (its lease ran out)';
export const LEASE_LOST = 'the job is no longer yours: it was finished, retried, or another worker took it';
export const MEDIA_GONE = 'the recording was deleted before it was transcribed';

export type Job = typeof reportJobs.$inferSelect;
type Attachment = typeof reportAttachments.$inferSelect;
export type ClaimedJob = { job: Job; attachment: Attachment; report: { id: string; projectId: string | null; title: string } };
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Video and audio are transcribed; photos and frames are not. */
export const isRecording = (a: { kind: string }): boolean => a.kind === 'video' || a.kind === 'audio';

/** Wakes long-polling claims in this process when a job may have become available. */
class JobSignal {
  private readonly waiters = new Set<() => void>();

  wake(): void {
    for (const w of [...this.waiters]) w();
  }

  /** Resolves on wake(), after `ms`, or when `signal` aborts, whichever comes first. */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    // An already aborted signal never fires 'abort' again.
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
export const jobSignal = new JobSignal();

/**
 * Queue the transcription of a recording; one already queued, running, failed or done is left alone. run_after comes
 * from this process's clock like every other queue time (the database's clock may differ by a few milliseconds).
 */
export async function enqueueTranscription(db: Db, attachmentId: string, now = new Date()): Promise<void> {
  await db.insert(reportJobs).values({ attachmentId, kind: 'transcribe', runAfter: now }).onConflictDoNothing();
  jobSignal.wake();
}

/**
 * Jobs whose worker stopped answering go back to the queue, or fail after the last attempt. Their lease id stays, so
 * a worker that only slept can take the job back with a heartbeat as long as nobody else claimed it. Returns how many.
 */
export async function expireLeases(db: Db, now = new Date()): Promise<number> {
  const last = sql`${reportJobs.attempts} >= ${MAX_ATTEMPTS}`;
  const rows = await db
    .update(reportJobs)
    .set({
      status: sql`CASE WHEN ${last} THEN 'failed'::job_status ELSE 'queued'::job_status END`,
      finishedAt: sql`CASE WHEN ${last} THEN ${now.toISOString()}::timestamptz ELSE NULL END`,
      error: LEASE_EXPIRED,
      leaseUntil: null,
      runAfter: now,
      updatedAt: now,
    })
    .where(and(eq(reportJobs.status, 'running'), lt(reportJobs.leaseUntil, now)))
    .returning({ id: reportJobs.id });
  if (rows.length) jobSignal.wake();
  return rows.length;
}

/** The next due job for `worker`, under a fresh lease; null when there is none. */
export async function claimJob(db: Db, worker: string, now = new Date()): Promise<ClaimedJob | null> {
  await expireLeases(db, now);
  return db.transaction(async (tx) => {
    // SKIP LOCKED: concurrent claims never wait for each other and never get the same job.
    const [next] = await tx
      .select({ id: reportJobs.id })
      .from(reportJobs)
      .innerJoin(reportAttachments, eq(reportAttachments.id, reportJobs.attachmentId))
      .where(and(eq(reportJobs.status, 'queued'), lte(reportJobs.runAfter, now), isNull(reportAttachments.purgedAt)))
      .orderBy(asc(reportJobs.runAfter), asc(reportJobs.createdAt))
      .limit(1)
      .for('update', { of: reportJobs, skipLocked: true });
    if (!next) return null;
    const [job] = await tx
      .update(reportJobs)
      .set({
        status: 'running',
        attempts: sql`${reportJobs.attempts} + 1`,
        leaseId: randomUUID(),
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        worker,
        startedAt: now,
        finishedAt: null,
        updatedAt: now,
      })
      .where(eq(reportJobs.id, next.id))
      .returning();
    const [row] = await tx
      .select({ attachment: reportAttachments, report: { id: reports.id, projectId: reports.projectId, title: reports.title } })
      .from(reportAttachments)
      .innerJoin(reports, eq(reports.id, reportAttachments.reportId))
      .where(eq(reportAttachments.id, job!.attachmentId));
    return { job: job!, attachment: row!.attachment, report: row!.report };
  });
}

/** The job, locked, if `lease` is still the holder's: nobody claimed it since and it is not done. */
async function ownedJob(tx: Tx, id: string, lease: string): Promise<Job> {
  const [job] = await tx.select().from(reportJobs).where(eq(reportJobs.id, id)).for('update');
  if (!job) throw notFound(`job ${id} does not exist (the recording was deleted?)`);
  if (job.leaseId !== lease || job.status === 'done') throw conflict(LEASE_LOST);
  return job;
}

/** Extend the lease while a long transcription runs; also takes back a job whose lease ran out meanwhile. */
export async function heartbeatJob(db: Db, id: string, lease: string, now = new Date()): Promise<{ leaseUntil: Date }> {
  return db.transaction(async (tx) => {
    await ownedJob(tx, id, lease);
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    await tx
      .update(reportJobs)
      .set({ status: 'running', leaseUntil, error: null, finishedAt: null, updatedAt: now })
      .where(eq(reportJobs.id, id));
    return { leaseUntil };
  });
}

const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;
const MODEL = /^[\x20-\x7e]{1,200}$/;

export type TranscriptInput = {
  language: string | null; model: string; durationMs: number | null; segments: IncomingSegment[];
  /** Absent or null: the worker has no speaker recognition. */
  diarization?: Diarization | null;
};

/**
 * Store the transcript and finish the job. The recording's duration is filled in when the upload had none (live
 * WebM recordings without ffmpeg on the server).
 */
export async function completeJob(db: Db, id: string, lease: string, input: TranscriptInput, now = new Date()): Promise<{ segments: number }> {
  if (input.language !== null && !LANGUAGE.test(input.language)) throw badRequest('language must be a language code such as "sk", or null');
  if (!MODEL.test(input.model)) throw badRequest('model must be a model name such as "large-v3"');
  if (input.durationMs !== null && (!Number.isInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > TRANSCRIPT_LIMITS.maxMs)) {
    throw badRequest('duration_ms must be a whole number of milliseconds up to 24 hours, or null');
  }
  const segments = cleanSegments(input.segments);
  const diarization = cleanDiarization(input.diarization);
  const language = input.language?.toLowerCase() ?? null;
  return db.transaction(async (tx) => {
    const job = await ownedJob(tx, id, lease);
    // A new transcript drops the names: a new run may number the same voices differently.
    const values = { language, model: input.model, text: transcriptText(segments), segments, diarization, speakers: {}, createdAt: now };
    await tx
      .insert(reportTranscripts)
      .values({ attachmentId: job.attachmentId, ...values })
      .onConflictDoUpdate({ target: reportTranscripts.attachmentId, set: values });
    await tx
      .update(reportJobs)
      .set({ status: 'done', leaseUntil: null, error: null, finishedAt: now, updatedAt: now })
      .where(eq(reportJobs.id, id));
    if (input.durationMs !== null) {
      await tx
        .update(reportAttachments)
        .set({ durationMs: input.durationMs })
        .where(and(eq(reportAttachments.id, job.attachmentId), isNull(reportAttachments.durationMs)));
    }
    return { segments: segments.length };
  });
}

/** One line of at most 500 characters: what the UI shows next to "Transcription failed". */
function cleanError(raw: string): string {
  const line = raw.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...(line || 'unknown error')].slice(0, 500).join('');
}

/** A failed attempt: back to the queue after a back-off, or failed for good after the last attempt or when permanent. */
export async function failJob(
  db: Db,
  id: string,
  lease: string,
  input: { error: string; permanent?: boolean },
  now = new Date(),
): Promise<{ status: 'queued' | 'failed'; retryAt: Date | null }> {
  const error = cleanError(input.error);
  return db.transaction(async (tx) => {
    const job = await ownedJob(tx, id, lease);
    const final = input.permanent === true || job.attempts >= MAX_ATTEMPTS;
    const retryAt = final ? null : new Date(now.getTime() + retryDelayMs(job.attempts));
    await tx
      .update(reportJobs)
      .set({
        status: final ? 'failed' : 'queued', error, leaseId: null, leaseUntil: null, runAfter: retryAt ?? now,
        finishedAt: final ? now : null, updatedAt: now,
      })
      .where(eq(reportJobs.id, id));
    if (!final) jobSignal.wake();
    return { status: final ? 'failed' : 'queued', retryAt };
  });
}

/** The worker gives the job back without trying (it was stopped, or its own setup is broken): the attempt does not count. */
export async function releaseJob(db: Db, id: string, lease: string, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    await ownedJob(tx, id, lease);
    await tx
      .update(reportJobs)
      .set({
        status: 'queued', attempts: sql`greatest(${reportJobs.attempts} - 1, 0)`, leaseId: null, leaseUntil: null, runAfter: now,
        finishedAt: null, updatedAt: now,
      })
      .where(eq(reportJobs.id, id));
  });
  jobSignal.wake();
}

/** The UI's "Try again": a failed job starts over; a recording without a job (older upload, no sound found) gets one. */
export async function retryTranscription(db: Db, attachmentId: string, now = new Date()): Promise<Job> {
  const [a] = await db.select().from(reportAttachments).where(eq(reportAttachments.id, attachmentId));
  if (!a) throw notFound(`attachment ${attachmentId} does not exist`);
  if (!isRecording(a)) throw badRequest('only video and audio are transcribed');
  if (a.purgedAt) throw conflict('the recording was deleted after the report was closed; it can no longer be transcribed');
  const [job] = await db
    .insert(reportJobs)
    .values({ attachmentId, kind: 'transcribe', runAfter: now })
    .onConflictDoUpdate({
      target: [reportJobs.attachmentId, reportJobs.kind],
      set: { status: 'queued', attempts: 0, error: null, leaseId: null, leaseUntil: null, runAfter: now, finishedAt: null, updatedAt: now },
      setWhere: eq(reportJobs.status, 'failed'),
    })
    .returning();
  if (!job) throw conflict('the recording is already waiting for the worker, being transcribed, or transcribed');
  jobSignal.wake();
  return job;
}

export const CLOSED_FOR_TRANSCRIPTION = 'the report is closed; reopen it to transcribe the recording again';

/**
 * The UI's "Transcribe again": a done or failed job starts over. The old transcript stays until the new one comes in;
 * completeJob then replaces it and clears the speaker names.
 */
export async function transcribeAgain(db: Db, attachmentId: string, now = new Date()): Promise<Job> {
  const [row] = await db
    .select({ a: reportAttachments, reportStatus: reports.status })
    .from(reportAttachments)
    .innerJoin(reports, eq(reports.id, reportAttachments.reportId))
    .where(eq(reportAttachments.id, attachmentId));
  if (!row) throw notFound(`attachment ${attachmentId} does not exist`);
  if (!isRecording(row.a)) throw badRequest('only video and audio are transcribed');
  if (row.a.purgedAt) throw conflict('the recording was deleted after the report was closed; it can no longer be transcribed');
  if (row.reportStatus === 'done') throw conflict(CLOSED_FOR_TRANSCRIPTION);
  const [job] = await db
    .insert(reportJobs)
    .values({ attachmentId, kind: 'transcribe', runAfter: now })
    .onConflictDoUpdate({
      target: [reportJobs.attachmentId, reportJobs.kind],
      set: { status: 'queued', attempts: 0, error: null, leaseId: null, leaseUntil: null, runAfter: now, finishedAt: null, updatedAt: now },
      setWhere: inArray(reportJobs.status, ['done', 'failed']),
    })
    .returning();
  if (!job) throw conflict('the recording is already waiting for the worker or being transcribed');
  jobSignal.wake();
  return job;
}

/** Recordings deleted before the worker got to them: their jobs fail with the reason instead of waiting forever. */
export async function failPendingJobs(db: Pick<Db, 'update'>, attachmentIds: string[], now = new Date()): Promise<void> {
  if (!attachmentIds.length) return;
  await db
    .update(reportJobs)
    .set({ status: 'failed', error: MEDIA_GONE, leaseId: null, leaseUntil: null, finishedAt: now, updatedAt: now })
    .where(and(inArray(reportJobs.attachmentId, attachmentIds), inArray(reportJobs.status, ['queued', 'running'])));
  // A job that failed on its last expired lease still holds that lease id; without clearing it a late heartbeat would revive it.
  await db
    .update(reportJobs)
    .set({ leaseId: null, updatedAt: now })
    .where(and(inArray(reportJobs.attachmentId, attachmentIds), eq(reportJobs.status, 'failed'), sql`${reportJobs.leaseId} IS NOT NULL`));
}

/** Every authenticated worker call is a sign of life. */
export async function touchWorker(db: Db, name: string, version: string | null, now = new Date()): Promise<void> {
  await db
    .insert(workers)
    .values({ name, version, lastSeenAt: now })
    .onConflictDoUpdate({ target: workers.name, set: { version, lastSeenAt: now } });
}

export async function lastWorkerSeen(db: Db): Promise<Date | null> {
  const [w] = await db.select({ at: workers.lastSeenAt }).from(workers).orderBy(desc(workers.lastSeenAt)).limit(1);
  return w?.at ?? null;
}

export async function queuedCount(db: Db): Promise<number> {
  const [r] = await db.select({ n: count() }).from(reportJobs).where(eq(reportJobs.status, 'queued'));
  return r?.n ?? 0;
}

/** Jobs waiting and running, over all reports (a claim takes every queued job, whatever its report's state). */
export async function jobCounts(db: Db): Promise<{ queued: number; running: number }> {
  const rows = await db
    .select({ status: reportJobs.status, n: count() })
    .from(reportJobs)
    .where(inArray(reportJobs.status, ['queued', 'running']))
    .groupBy(reportJobs.status);
  const n = (s: Job['status']) => rows.find((r) => r.status === s)?.n ?? 0;
  return { queued: n('queued'), running: n('running') };
}

/** When the worker of this name last called the server; null when it never did. */
export async function workerSeenAt(db: Db, name: string): Promise<Date | null> {
  const [w] = await db.select({ at: workers.lastSeenAt }).from(workers).where(eq(workers.name, name));
  return w?.at ?? null;
}

export type WorkerStatus = {
  lastSeenAt: string | null;
  workers: Array<{ name: string; version: string | null; lastSeenAt: string }>;
  /** Jobs of open reports by state. */
  queued: number;
  running: number;
  failed: number;
};

export async function transcriptionStatus(db: Db): Promise<WorkerStatus> {
  const [seen, counts] = await Promise.all([
    db.select().from(workers).orderBy(desc(workers.lastSeenAt)).limit(10),
    db
      .select({ status: reportJobs.status, n: count() })
      .from(reportJobs)
      .innerJoin(reportAttachments, eq(reportAttachments.id, reportJobs.attachmentId))
      .innerJoin(reports, eq(reports.id, reportAttachments.reportId))
      .where(ne(reports.status, 'done'))
      .groupBy(reportJobs.status),
  ]);
  const n = (s: Job['status']) => counts.find((c) => c.status === s)?.n ?? 0;
  return {
    lastSeenAt: seen[0]?.lastSeenAt.toISOString() ?? null,
    workers: seen.map((w) => ({ name: w.name, version: w.version, lastSeenAt: w.lastSeenAt.toISOString() })),
    queued: n('queued'),
    running: n('running'),
    failed: n('failed'),
  };
}

/** A recording transcribed again: the job's state while the old transcript stays on show. */
export type TranscribingAgain = { status: 'queued' | 'running' | 'failed'; error: string | null; retryAt: string | null };

export type TranscriptState =
  | { status: 'none' }
  | { status: 'queued' | 'running' | 'failed'; attempts: number; error: string | null; retryAt: string | null }
  | {
      status: 'done'; language: string | null; model: string; segments: TranscriptSegment[]; createdAt: string;
      diarization: Diarization | null; speakers: SpeakerNames;
      /** Set while the recording is transcribed again, or when that failed; this transcript stays until a new one is in. */
      again: TranscribingAgain | null;
    };

/** The transcript, or the state of its job, for each recording that has either; recordings without both are absent. */
export async function transcriptStates(db: Db, attachmentIds: readonly string[], now = new Date()): Promise<Map<string, TranscriptState>> {
  const states = new Map<string, TranscriptState>();
  if (!attachmentIds.length) return states;
  const ids = [...attachmentIds];
  const [jobs, done] = await Promise.all([
    db
      .select({ attachmentId: reportJobs.attachmentId, status: reportJobs.status, attempts: reportJobs.attempts, error: reportJobs.error, runAfter: reportJobs.runAfter })
      .from(reportJobs)
      .where(inArray(reportJobs.attachmentId, ids)),
    db
      .select({
        attachmentId: reportTranscripts.attachmentId, language: reportTranscripts.language, model: reportTranscripts.model,
        segments: reportTranscripts.segments, createdAt: reportTranscripts.createdAt,
        diarization: reportTranscripts.diarization, speakers: reportTranscripts.speakers,
      })
      .from(reportTranscripts)
      .where(inArray(reportTranscripts.attachmentId, ids)),
  ]);
  const pending = new Map<string, TranscribingAgain>();
  for (const j of jobs) {
    if (j.status === 'done') continue;
    const retryAt = j.status === 'queued' && j.runAfter > now ? j.runAfter.toISOString() : null;
    pending.set(j.attachmentId, { status: j.status, error: j.error, retryAt });
    states.set(j.attachmentId, { status: j.status, attempts: j.attempts, error: j.error, retryAt });
  }
  // A transcript wins over its job's state: it is what the user wants to see.
  for (const t of done) {
    states.set(t.attachmentId, {
      status: 'done', language: t.language, model: t.model, segments: t.segments, createdAt: t.createdAt.toISOString(),
      diarization: t.diarization, speakers: t.speakers, again: pending.get(t.attachmentId) ?? null,
    });
  }
  return states;
}

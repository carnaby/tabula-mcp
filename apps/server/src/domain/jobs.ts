import { and, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  type Diarization, reportAttachments, reportJobs, reports, reportTranscripts, type SpeakerNames, type TranscriptSegment,
} from '../db/schema.js';
import { badRequest, conflict, notFound } from './errors.js';
import { cleanDiarization, type Tx } from './speakers.js';
import { cleanSegments, type IncomingSegment, TRANSCRIPT_LIMITS, transcriptText } from './transcripts.js';

/** Submits to Fornax: a failed upload or submit is tried again after a back-off, this many attempts in all. */
export const MAX_ATTEMPTS = 3;
/** Wait before the next attempt after the n-th failed one: 1 minute, then 4. */
export const retryDelayMs = (attempts: number): number => 60_000 * 4 ** Math.max(0, attempts - 1);

export const MEDIA_GONE = 'the recording was deleted before it was transcribed';
export const DOCUMENT_GONE = 'the document was deleted before it was read';

/** What a job does: transcribe a recording, or parse (read the text of) a document. */
export type JobKind = 'transcribe' | 'parse';

export type Job = typeof reportJobs.$inferSelect;

/** Video and audio are transcribed; photos and frames are not. */
export const isRecording = (a: { kind: string }): boolean => a.kind === 'video' || a.kind === 'audio';

/**
 * Queue the transcription of a recording; one already queued, running, failed or done is left alone. run_after comes
 * from this process's clock like every other queue time (the database's clock may differ by a few milliseconds).
 * The Fornax sync submits it within seconds.
 */
export async function enqueueTranscription(db: Db, attachmentId: string, now = new Date()): Promise<void> {
  await db.insert(reportJobs).values({ attachmentId, kind: 'transcribe', runAfter: now }).onConflictDoNothing();
}

/** A job that starts over: a new upload and a new Fornax job, with all its attempts again. */
export const startOver = (now: Date) => ({
  status: 'queued' as const, attempts: 0, error: null, fornaxJobId: null, fornaxChange: null, note: null, progress: null,
  progressMessage: null, submitting: false, runAfter: now, startedAt: null, finishedAt: null, updatedAt: now,
});

const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;
const MODEL = /^[\x20-\x7e]{1,200}$/;

export type TranscriptInput = {
  language: string | null; model: string; durationMs: number | null; segments: IncomingSegment[];
  /** Absent or null: no speaker recognition (or the transcript came before it). */
  diarization?: Diarization | null;
};

/**
 * Store the transcript and finish the job, inside the caller's transaction (the sync checks there, under the same
 * lock, that the job is still the one Fornax finished). The recording's duration is filled in when the upload had
 * none (live WebM recordings without ffmpeg on the server). Locks the job row before the attachment row, as
 * purgeClosedMedia does.
 */
export async function storeTranscript(tx: Tx, jobId: string, input: TranscriptInput, now = new Date()): Promise<{ segments: number }> {
  if (input.language !== null && !LANGUAGE.test(input.language)) throw badRequest('language must be a language code such as "sk", or null');
  if (!MODEL.test(input.model)) throw badRequest('model must be a model name such as "large-v3"');
  if (input.durationMs !== null && (!Number.isInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > TRANSCRIPT_LIMITS.maxMs)) {
    throw badRequest('duration_ms must be a whole number of milliseconds up to 24 hours, or null');
  }
  const segments = cleanSegments(input.segments);
  const diarization = cleanDiarization(input.diarization);
  const language = input.language?.toLowerCase() ?? null;
  const [job] = await tx.select().from(reportJobs).where(eq(reportJobs.id, jobId)).for('update');
  if (!job) throw notFound(`job ${jobId} does not exist (the recording was deleted?)`);
  // A new transcript drops the names: a new run may number the same voices differently.
  const values = { language, model: input.model, text: transcriptText(segments), segments, diarization, speakers: {}, createdAt: now };
  await tx
    .insert(reportTranscripts)
    .values({ attachmentId: job.attachmentId, ...values })
    .onConflictDoUpdate({ target: reportTranscripts.attachmentId, set: values });
  await tx
    .update(reportJobs)
    .set({ status: 'done', error: null, note: null, submitting: false, finishedAt: now, updatedAt: now })
    .where(eq(reportJobs.id, jobId));
  if (input.durationMs !== null) {
    await tx
      .update(reportAttachments)
      .set({ durationMs: input.durationMs })
      .where(and(eq(reportAttachments.id, job.attachmentId), isNull(reportAttachments.durationMs)));
  }
  return { segments: segments.length };
}

/** One line of at most 500 characters: what the UI shows next to "Transcription failed". */
export function cleanError(raw: string): string {
  const line = raw.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...(line || 'unknown error')].slice(0, 500).join('');
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
    .onConflictDoUpdate({ target: [reportJobs.attachmentId, reportJobs.kind], set: startOver(now), setWhere: eq(reportJobs.status, 'failed') })
    .returning();
  if (!job) throw conflict('the recording is already waiting for Fornax, being transcribed, or transcribed');
  return job;
}

export const CLOSED_FOR_TRANSCRIPTION = 'the report is closed; reopen it to transcribe the recording again';

/**
 * The UI's "Transcribe again": a done or failed job starts over. The old transcript stays until the new one comes in;
 * storeTranscript then replaces it and clears the speaker names.
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
      set: startOver(now),
      setWhere: inArray(reportJobs.status, ['done', 'failed']),
    })
    .returning();
  if (!job) throw conflict('the recording is already waiting for Fornax or being transcribed');
  return job;
}

/**
 * Recordings and documents deleted before Fornax finished them: their jobs fail with the reason instead of waiting
 * forever. A job Fornax still works on is no longer followed, and a result that comes for it later is not stored.
 */
export async function failPendingJobs(db: Pick<Db, 'update'>, attachmentIds: string[], now = new Date()): Promise<void> {
  if (!attachmentIds.length) return;
  await db
    .update(reportJobs)
    .set({
      status: 'failed',
      error: sql`CASE WHEN ${reportJobs.kind} = 'parse' THEN ${DOCUMENT_GONE}::text ELSE ${MEDIA_GONE}::text END`,
      note: null, submitting: false, finishedAt: now, updatedAt: now,
    })
    .where(and(inArray(reportJobs.attachmentId, attachmentIds), inArray(reportJobs.status, ['queued', 'running'])));
}

export type JobCounts = {
  /** Jobs of open reports by state. */
  queued: number;
  running: number;
  failed: number;
};

/** How many recordings of open reports wait, run and failed. */
export async function transcriptionStatus(db: Db): Promise<JobCounts> {
  const counts = await db
    .select({ status: reportJobs.status, n: count() })
    .from(reportJobs)
    .innerJoin(reportAttachments, eq(reportAttachments.id, reportJobs.attachmentId))
    .innerJoin(reports, eq(reports.id, reportAttachments.reportId))
    .where(ne(reports.status, 'done'))
    .groupBy(reportJobs.status);
  const n = (s: Job['status']) => counts.find((c) => c.status === s)?.n ?? 0;
  return { queued: n('queued'), running: n('running'), failed: n('failed') };
}

/** How far Fornax is with a running job: a whole percent 0–100 and what it does now (both null when it does not say). */
export type Progress = { progress: number | null; progressMessage: string | null };

/** A recording transcribed again: the job's state while the old transcript stays on show. */
export type TranscribingAgain = {
  status: 'queued' | 'running' | 'failed'; error: string | null; retryAt: string | null;
  /** Why the job waits in Fornax (see TranscriptState). */
  note: string | null;
} & Progress;

export type TranscriptState =
  | { status: 'none' }
  | {
      status: 'queued'; attempts: number; error: string | null; retryAt: string | null;
      /** Why the job waits in Fornax, one sentence from Fornax (e.g. the worker is offline); null when it says nothing. */
      note: string | null;
    }
  | ({ status: 'running'; attempts: number; error: string | null; retryAt: string | null; note: string | null } & Progress)
  | { status: 'failed'; attempts: number; error: string | null; retryAt: string | null }
  | {
      status: 'done'; language: string | null; model: string; segments: TranscriptSegment[]; createdAt: string;
      diarization: Diarization | null; speakers: SpeakerNames;
      /** Set while the recording is transcribed again, or when that failed; this transcript stays until a new one is in. */
      again: TranscribingAgain | null;
    };

/** The state of a job that is not done: waiting (with the back-off), running (with progress) or failed. */
export type PendingState = Exclude<TranscriptState, { status: 'none' | 'done' }>;

export function pendingState(
  j: {
    status: 'queued' | 'running' | 'failed'; attempts: number; error: string | null; runAfter: Date; note: string | null;
    progress: number | null; progressMessage: string | null;
  },
  now: Date,
): PendingState {
  const retryAt = j.status === 'queued' && j.runAfter > now ? j.runAfter.toISOString() : null;
  const base = { attempts: j.attempts, error: j.error, retryAt };
  if (j.status === 'failed') return { status: 'failed', ...base };
  // Progress belongs to a running job only; a job back in the queue starts from nothing.
  if (j.status === 'running') return { status: 'running', ...base, note: j.note, progress: j.progress, progressMessage: j.progressMessage };
  return { status: 'queued', ...base, note: j.note };
}

/** The transcript, or the state of its job, for each recording that has either; recordings without both are absent. */
export async function transcriptStates(db: Db, attachmentIds: readonly string[], now = new Date()): Promise<Map<string, TranscriptState>> {
  const states = new Map<string, TranscriptState>();
  if (!attachmentIds.length) return states;
  const ids = [...attachmentIds];
  const [jobs, done] = await Promise.all([
    db
      .select({
        attachmentId: reportJobs.attachmentId, status: reportJobs.status, attempts: reportJobs.attempts, error: reportJobs.error,
        runAfter: reportJobs.runAfter, note: reportJobs.note, progress: reportJobs.progress, progressMessage: reportJobs.progressMessage,
      })
      .from(reportJobs)
      .where(and(inArray(reportJobs.attachmentId, ids), eq(reportJobs.kind, 'transcribe'))),
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
    const s = pendingState({ ...j, status: j.status }, now);
    const progress: Progress = s.status === 'running'
      ? { progress: s.progress, progressMessage: s.progressMessage }
      : { progress: null, progressMessage: null };
    pending.set(j.attachmentId, { status: s.status, error: s.error, retryAt: s.retryAt, note: s.status === 'failed' ? null : s.note, ...progress });
    states.set(j.attachmentId, s);
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

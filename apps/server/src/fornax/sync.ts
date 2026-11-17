import { and, asc, eq, inArray, isNotNull, isNull, lte, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { projects, reportAttachments, reportJobs, reports } from '../db/schema.js';
import { DomainError, loggableError } from '../domain/errors.js';
import { cleanError, MAX_ATTEMPTS, MEDIA_GONE, retryDelayMs, storeTranscript, type TranscriptInput } from '../domain/jobs.js';
import type { MediaStore } from '../media/store.js';
import { type FornaxClient, FornaxError, type FornaxJob } from './client.js';

export const FORNAX_CANCELED = 'the job was canceled in Fornax';
export const FORNAX_FORGOT = 'Fornax no longer knows this job';
const TRANSCRIPT_OUTPUT = 'transcript.json';
/** Fornax takes an initial prompt of up to 1000 characters. */
const PROMPT_MAX = 1000;

type LogFn = (obj: object, msg: string) => void;
export type SyncLog = { info: LogFn; warn: LogFn; error: LogFn };

export type SyncTiming = {
  /** How often due jobs are submitted and newly submitted jobs are picked up for following. */
  tickMs: number;
  /** The pause after a failed long poll before the next one. */
  retryMs: number;
  /** How long one long poll waits for the job to change, in seconds (Fornax allows up to 30). */
  waitS: number;
};
const TIMING: SyncTiming = { tickMs: 5000, retryMs: 10_000, waitS: 25 };

/** transcript.json of a Fornax transcribe job; anything beyond the shape is checked when it is stored. */
const transcriptOutput = z.object({
  model: z.string(),
  language: z.string().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  segments: z.array(z.object({ start_ms: z.number(), end_ms: z.number(), text: z.string(), speaker: z.string().nullish() })),
  diarization: z.union([z.object({ model: z.string(), speakers: z.number() }), z.object({ error: z.string() })]).nullable().optional(),
});

/** The output as storeTranscript takes it. When speaker recognition failed, the transcript is stored without speakers. */
function transcriptInput(raw: unknown): TranscriptInput {
  const parsed = transcriptOutput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new DomainError('bad_request', `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`);
  }
  const t = parsed.data;
  const failed = t.diarization != null && 'error' in t.diarization;
  return {
    language: t.language ?? null,
    model: t.model,
    durationMs: t.duration_ms == null ? null : Math.round(t.duration_ms),
    segments: failed ? t.segments.map(({ speaker: _speaker, ...s }) => s) : t.segments,
    diarization: t.diarization ?? null,
  };
}

type Claimed = { id: string; attempts: number; attachmentId: string; storageKey: string; purgedAt: Date | null; project: string | null };
type Followed = { id: string; fornaxJobId: string; fornaxChange: string | null };

/**
 * Moves transcription jobs to Fornax and back. Submitting: a due queued job is claimed (FOR UPDATE SKIP LOCKED, then
 * `submitting` marks it outside the transaction), its recording is uploaded, the job submitted, and the Fornax id
 * saved. Following: each job with a Fornax id is asked about until Fornax finishes it; the transcript is then fetched
 * and stored. Every write after a call to Fornax checks that the row is still the job the call was about (it may have
 * been retried, transcribed again, or failed because its recording was deleted meanwhile).
 */
export function createFornaxSync(deps: { db: Db; store: MediaStore; client: FornaxClient; log: SyncLog; timing?: Partial<SyncTiming> }) {
  const { db, store, client, log } = deps;
  const timing = { ...TIMING, ...deps.timing };
  const stopping = new AbortController();
  const followers = new Map<string, { stop: AbortController; done: Promise<void> }>();
  let started: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let submitting: Promise<void> | null = null;
  let scanning: Promise<void> | null = null;

  /** The next due job nobody submits yet, marked as being submitted; null when there is none. */
  async function claim(now: Date, skip: string[]): Promise<Claimed | null> {
    return db.transaction(async (tx) => {
      const [next] = await tx
        .select({ id: reportJobs.id })
        .from(reportJobs)
        .where(
          and(
            eq(reportJobs.status, 'queued'),
            isNull(reportJobs.fornaxJobId),
            eq(reportJobs.submitting, false),
            lte(reportJobs.runAfter, now),
            skip.length ? notInArray(reportJobs.id, skip) : undefined,
          ),
        )
        .orderBy(asc(reportJobs.runAfter), asc(reportJobs.createdAt))
        .limit(1)
        // SKIP LOCKED: two syncs never wait for each other and never take the same job.
        .for('update', { skipLocked: true });
      if (!next) return null;
      await tx.update(reportJobs).set({ submitting: true, updatedAt: now }).where(eq(reportJobs.id, next.id));
      const [row] = await tx
        .select({
          id: reportJobs.id, attempts: reportJobs.attempts, attachmentId: reportJobs.attachmentId,
          storageKey: reportAttachments.storageKey, purgedAt: reportAttachments.purgedAt, project: projects.name,
        })
        .from(reportJobs)
        .innerJoin(reportAttachments, eq(reportAttachments.id, reportJobs.attachmentId))
        .innerJoin(reports, eq(reports.id, reportAttachments.reportId))
        .leftJoin(projects, eq(projects.id, reports.projectId))
        .where(eq(reportJobs.id, next.id));
      return row ?? null;
    });
  }

  /** Only the claim that is still being submitted may be written: the job may have failed or gone meanwhile. */
  const stillClaimed = (id: string) =>
    and(eq(reportJobs.id, id), eq(reportJobs.status, 'queued'), eq(reportJobs.submitting, true), isNull(reportJobs.fornaxJobId));

  /** Give a claimed job back without counting an attempt (the sync stops). */
  async function release(job: Claimed, now: Date): Promise<void> {
    await db.update(reportJobs).set({ submitting: false, updatedAt: now }).where(stillClaimed(job.id));
  }

  async function failClaimed(job: Claimed, error: string, now: Date): Promise<void> {
    await db
      .update(reportJobs)
      .set({ status: 'failed', error, submitting: false, finishedAt: now, updatedAt: now })
      .where(stillClaimed(job.id));
  }

  /** A failed upload or submit: back to the queue after a back-off, or failed after the last attempt or a refusal. */
  async function submitFailed(job: Claimed, e: unknown, now: Date): Promise<void> {
    const permanent = e instanceof FornaxError && e.permanent;
    const attempts = job.attempts + 1;
    const final = permanent || attempts >= MAX_ATTEMPTS;
    const error = cleanError(e instanceof Error ? e.message : String(e));
    await db
      .update(reportJobs)
      .set({
        status: final ? 'failed' : 'queued', attempts, error, submitting: false,
        runAfter: final ? now : new Date(now.getTime() + retryDelayMs(attempts)), finishedAt: final ? now : null, updatedAt: now,
      })
      .where(stillClaimed(job.id));
    log.warn(
      { job: job.id, attempts, err: loggableError(e) },
      final ? 'could not submit a recording to Fornax; the transcription failed' : 'could not submit a recording to Fornax; trying again later',
    );
  }

  /** `clock`: an upload may take hours, so every write takes the time anew. */
  async function submit(job: Claimed, clock: () => Date): Promise<void> {
    if (stopping.signal.aborted) return release(job, clock());
    const size = job.purgedAt ? null : await store.size(job.storageKey);
    if (size === null) return failClaimed(job, MEDIA_GONE, clock());
    let submitted: FornaxJob;
    // A fresh stream for every attempt: a stream an attempt read cannot be sent again.
    const body = store.open(job.storageKey);
    try {
      // The name carries the extension Fornax checks, not the user's file name.
      const name = job.storageKey.slice(job.storageKey.lastIndexOf('/') + 1);
      const file = await client.uploadFile(name, body, size, stopping.signal);
      const params = { diarize: true, ...(job.project ? { initial_prompt: [...job.project].slice(0, PROMPT_MAX).join('') } : {}) };
      submitted = await client.submit({ params, fileId: file.id }, stopping.signal);
    } catch (e) {
      // Stopped: the abort is no failure of Fornax and costs no attempt.
      if (stopping.signal.aborted && !(e instanceof FornaxError)) return release(job, clock());
      return submitFailed(job, e, clock());
    } finally {
      body.destroy();
    }
    const now = clock();
    const saved = await db
      .update(reportJobs)
      .set({
        status: submitted.state === 'running' ? 'running' : 'queued', fornaxJobId: submitted.id, fornaxChange: submitted.change,
        note: submitted.note, submitting: false, attempts: job.attempts + 1, error: null, startedAt: now, updatedAt: now,
      })
      .where(stillClaimed(job.id))
      .returning({ id: reportJobs.id });
    if (saved.length) log.info({ job: job.id, fornax: submitted.id }, 'submitted a recording to Fornax');
    else log.warn({ job: job.id, fornax: submitted.id }, 'the transcription changed while it was submitted to Fornax; its Fornax job is not followed');
  }

  /** Submit every due job, one after another. */
  async function submitDue(clock: () => Date): Promise<void> {
    const tried: string[] = [];
    while (!stopping.signal.aborted) {
      const job = await claim(clock(), tried);
      if (!job) return;
      tried.push(job.id);
      try {
        await submit(job, clock);
      } catch (e) {
        // A database error after the claim: the job stays marked until the next start of the sync takes it back.
        log.error({ job: job.id, err: loggableError(e) }, 'could not submit a recording to Fornax');
      }
    }
  }

  /** The jobs Fornax works on: queued or running here, with a Fornax id. */
  const followedJobs = (): Promise<Followed[]> =>
    db
      .select({ id: reportJobs.id, fornaxJobId: reportJobs.fornaxJobId, fornaxChange: reportJobs.fornaxChange })
      .from(reportJobs)
      .where(and(inArray(reportJobs.status, ['queued', 'running']), isNotNull(reportJobs.fornaxJobId))) as Promise<Followed[]>;

  /** Only the job the answer is about may be written: still waiting for this Fornax job. */
  const stillFollowed = (job: Followed) =>
    and(eq(reportJobs.id, job.id), eq(reportJobs.fornaxJobId, job.fornaxJobId), inArray(reportJobs.status, ['queued', 'running']));

  async function failFollowed(job: Followed, error: string, now: Date): Promise<void> {
    await db
      .update(reportJobs)
      .set({ status: 'failed', error: cleanError(error), note: null, finishedAt: now, updatedAt: now })
      .where(stillFollowed(job));
  }

  /** Fornax finished: fetch the transcript and store it, unless the job changed here meanwhile. */
  async function finish(job: Followed, now: Date, signal?: AbortSignal): Promise<void> {
    let input: TranscriptInput;
    try {
      input = transcriptInput(await client.output(job.fornaxJobId, TRANSCRIPT_OUTPUT, signal));
    } catch (e) {
      if (e instanceof FornaxError && e.permanent) return failFollowed(job, `the transcript could not be fetched from Fornax: ${e.message}`, now);
      if (e instanceof DomainError) return failFollowed(job, `the transcript from Fornax could not be stored: ${e.message}`, now);
      // Fornax unreachable: the next poll tries again.
      throw e;
    }
    try {
      const stored = await db.transaction(async (tx) => {
        const [row] = await tx.select({ id: reportJobs.id }).from(reportJobs).where(stillFollowed(job)).for('update');
        if (!row) return null;
        return storeTranscript(tx, job.id, input, now);
      });
      if (stored) log.info({ job: job.id, fornax: job.fornaxJobId, segments: stored.segments }, 'stored a transcript from Fornax');
    } catch (e) {
      if (e instanceof DomainError) return failFollowed(job, `the transcript from Fornax could not be stored: ${e.message}`, now);
      throw e;
    }
  }

  /** Apply what Fornax says about a job. Returns false when the job needs no more following. */
  async function apply(job: Followed, seen: FornaxJob | null, now: Date, signal?: AbortSignal): Promise<boolean> {
    if (!seen) {
      await failFollowed(job, FORNAX_FORGOT, now);
      return false;
    }
    switch (seen.state) {
      case 'succeeded':
        await finish(job, now, signal);
        return false;
      case 'failed':
        await failFollowed(job, seen.error ?? 'the job failed in Fornax', now);
        return false;
      case 'canceled':
        await failFollowed(job, FORNAX_CANCELED, now);
        return false;
      default: {
        if (seen.change === job.fornaxChange) return true;
        const [row] = await db
          .update(reportJobs)
          .set({ status: seen.state, note: seen.note, fornaxChange: seen.change, updatedAt: now })
          .where(stillFollowed(job))
          .returning({ id: reportJobs.id });
        if (!row) return false;
        job.fornaxChange = seen.change;
        return true;
      }
    }
  }

  /** Ask once about every followed job; Fornax being unreachable changes nothing and counts no attempt. */
  async function followAll(now: Date): Promise<void> {
    for (const job of await followedJobs()) {
      if (stopping.signal.aborted) return;
      try {
        const seen = await client.job(job.fornaxJobId, { wait: 0, ...(job.fornaxChange ? { change: job.fornaxChange } : {}), signal: stopping.signal });
        await apply(job, seen, now, stopping.signal);
      } catch (e) {
        if (stopping.signal.aborted) return;
        log.warn({ job: job.id, fornax: job.fornaxJobId, err: loggableError(e) }, 'could not follow a transcription in Fornax; asking again later');
      }
    }
  }

  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(t);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const t = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });

  /** One long poll after another until the job is finished here or the follower is stopped. */
  async function follow(job: Followed, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const seen = await client.job(job.fornaxJobId, { wait: timing.waitS, ...(job.fornaxChange ? { change: job.fornaxChange } : {}), signal });
        if (!(await apply(job, seen, new Date(), signal))) return;
      } catch (e) {
        if (signal.aborted) return;
        log.warn({ job: job.id, fornax: job.fornaxJobId, err: loggableError(e) }, 'could not follow a transcription in Fornax; asking again shortly');
        await pause(timing.retryMs, signal);
      }
    }
  }

  /** A follower for every followed job that has none; followers of jobs no longer followed (failed, retried) stop. */
  async function scan(): Promise<void> {
    const jobs = await followedJobs();
    const current = new Set(jobs.map((j) => j.fornaxJobId));
    for (const [id, f] of followers) if (!current.has(id)) f.stop.abort();
    for (const job of jobs) {
      if (followers.has(job.fornaxJobId) || stopping.signal.aborted) continue;
      const stop = new AbortController();
      const done = follow(job, AbortSignal.any([stopping.signal, stop.signal]))
        .catch((e: unknown) => log.error({ job: job.id, err: loggableError(e) }, 'following a transcription in Fornax stopped'))
        .finally(() => followers.delete(job.fornaxJobId));
      followers.set(job.fornaxJobId, { stop, done });
    }
  }

  /** Every tick: submit due jobs (unless a submit still runs: an upload may take hours) and follow new ones. */
  function tick(): void {
    if (stopping.signal.aborted) return;
    submitting ??= submitDue(() => new Date())
      .catch((e: unknown) => log.error({ err: loggableError(e) }, 'could not submit recordings to Fornax'))
      .finally(() => {
        submitting = null;
      });
    scanning ??= scan()
      .catch((e: unknown) => log.error({ err: loggableError(e) }, 'could not look for transcriptions to follow in Fornax'))
      .finally(() => {
        scanning = null;
      });
  }

  return {
    /** Submit what is due, then ask once about every followed job (without waiting for changes). */
    async syncOnce(now = new Date()): Promise<void> {
      await submitDue(() => now);
      await followAll(now);
    },

    start(): void {
      if (started || stopping.signal.aborted) return;
      started = (async () => {
        // A submit the previous run of the server did not finish: nobody uploads it any more.
        try {
          await db.update(reportJobs).set({ submitting: false }).where(and(eq(reportJobs.submitting, true), isNull(reportJobs.fornaxJobId)));
        } catch (e) {
          log.error({ err: loggableError(e) }, 'could not take back interrupted submits to Fornax');
        }
        if (stopping.signal.aborted) return;
        tick();
        timer = setInterval(tick, timing.tickMs);
      })();
    },

    /** Stops submitting and every long poll, and waits for them to end (an interrupted upload is given back). */
    async stop(): Promise<void> {
      stopping.abort();
      await started;
      if (timer) clearInterval(timer);
      await Promise.allSettled([submitting, scanning, ...[...followers.values()].map((f) => f.done)]);
    },
  };
}

export type FornaxSync = ReturnType<typeof createFornaxSync>;

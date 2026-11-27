import { and, asc, eq, inArray, isNotNull, isNull, lte, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { projects, reportAttachments, reportJobs, reports } from '../db/schema.js';
import { DOCUMENT_LIMITS, storeParsedDocument } from '../domain/documents.js';
import { DomainError, loggableError } from '../domain/errors.js';
import {
  cleanError, DOCUMENT_GONE, type JobKind, MAX_ATTEMPTS, MEDIA_GONE, type Progress, retryDelayMs, storeTranscript, type TranscriptInput,
} from '../domain/jobs.js';
import type { MediaStore } from '../media/store.js';
import { type FornaxClient, FornaxError, type FornaxJob } from './client.js';

export const FORNAX_CANCELED = 'the job was canceled in Fornax';
export const FORNAX_FORGOT = 'Fornax no longer knows this job';
/** What Fornax does with each kind of job: its job type, the name of its input and output, what it reads. */
const KINDS: Record<JobKind, { type: string; input: string; output: string; what: 'recording' | 'document'; gone: string }> = {
  transcribe: { type: 'transcribe', input: 'audio', output: 'transcript.json', what: 'recording', gone: MEDIA_GONE },
  parse: { type: 'document-parse', input: 'document', output: 'document.md', what: 'document', gone: DOCUMENT_GONE },
};
/** How the logs and errors name the work of a job (a transcription's texts stay as they always were). */
const WORDS: Record<JobKind, { work: string; failed: string; unreadable: string; changed: string }> = {
  transcribe: {
    work: 'a transcription', failed: 'the transcription failed', unreadable: 'the recording could not be read', changed: 'the transcription',
  },
  parse: {
    work: 'the reading of a document', failed: 'reading it failed', unreadable: 'the document file could not be read',
    changed: 'the reading of the document',
  },
};
/** Fornax takes an initial prompt of up to 1000 characters. */
const PROMPT_MAX = 1000;
/** The largest value of an integer column. */
const INT_MAX = 2_147_483_647;

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
/** How long a recording waits after Fornax did not accept the token. */
const AUTH_RETRY_MS = 60_000;
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

/**
 * What Fornax says about the text of a document (the `meta` of its output document.md): the page and table counts
 * when they are whole numbers a column holds, and the docling version as the model. Anything else is left out.
 */
function documentMeta(meta: Record<string, unknown> | null): { model: string | null; pages: number | null; tables: number | null } {
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= INT_MAX ? v : null);
  const docling = meta?.docling;
  return {
    model: typeof docling === 'string' && /^[\x20-\x7e]{1,100}$/.test(docling) ? `docling ${docling}` : null,
    pages: count(meta?.pages),
    tables: count(meta?.tables),
  };
}

type Claimed = {
  id: string; kind: JobKind; attempts: number; attachmentId: string; storageKey: string; purgedAt: Date | null; project: string | null;
};
/** A job Fornax works on, as last stored here; `fornaxChange` also as last seen (kept in memory between stored states). */
type Followed = {
  id: string; kind: JobKind; fornaxJobId: string; fornaxChange: string | null; status: 'queued' | 'running'; note: string | null;
} & Progress;

const NO_PROGRESS: Progress = { progress: null, progressMessage: null };

/**
 * Fornax's progress of a running job as stored here: a whole percent (Fornax reports a fraction 0..1 on every
 * heartbeat; finer steps write nothing) and its message as one line. A waiting job has none.
 */
function progressOf(job: FornaxJob): Progress {
  if (job.state !== 'running' || !job.progress) return NO_PROGRESS;
  const { done, total, message } = job.progress;
  const fraction = done != null && total ? done / total : null;
  const line = (message ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    progress: fraction === null || !Number.isFinite(fraction) ? null : Math.round(Math.min(Math.max(fraction, 0), 1) * 100),
    progressMessage: line ? [...line].slice(0, 200).join('') : null,
  };
}

/**
 * Moves jobs to Fornax and back: transcriptions of recordings and readings of documents (`KINDS`). Submitting: a due
 * queued job is claimed (FOR UPDATE SKIP LOCKED, then `submitting` marks it outside the transaction), its file is
 * uploaded, the job submitted, and the Fornax id saved. Following: each job with a Fornax id is asked about until Fornax
 * finishes it; the transcript or the text is then fetched and stored. Every write after a call to Fornax checks that the
 * row is still the job the call was about (it may have been retried, transcribed again, or failed because its file was
 * deleted meanwhile).
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
          id: reportJobs.id, kind: reportJobs.kind, attempts: reportJobs.attempts, attachmentId: reportJobs.attachmentId,
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

  /** Fornax does not accept the token (yet): the job waits with the reason as its note, and no attempt is counted. */
  async function submitRefused(job: Claimed, e: FornaxError, now: Date): Promise<void> {
    const note = cleanError(e.message);
    const [row] = await db
      .update(reportJobs)
      .set({ submitting: false, note, runAfter: new Date(now.getTime() + AUTH_RETRY_MS), updatedAt: now })
      .where(stillClaimed(job.id))
      .returning({ id: reportJobs.id });
    if (row) {
      log.warn({ job: job.id, err: loggableError(e) }, `Fornax does not accept the token; the ${KINDS[job.kind].what} waits and is submitted again later`);
    }
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
      `could not submit a ${KINDS[job.kind].what} to Fornax; ${final ? WORDS[job.kind].failed : 'trying again later'}`,
    );
  }

  /** The size limit of a document in Fornax, in MB; null (upload anyway) when there is none or it cannot be read. */
  async function documentLimitMb(job: Claimed): Promise<number | null> {
    try {
      return await client.inputLimitMb(KINDS.parse.type, KINDS.parse.input);
    } catch (e) {
      log.warn({ job: job.id, err: loggableError(e) }, 'could not read the size limit of documents in Fornax; uploading the document anyway');
      return null;
    }
  }

  /** `clock`: an upload may take hours, so every write takes the time anew. */
  async function submit(job: Claimed, clock: () => Date): Promise<void> {
    if (stopping.signal.aborted) return release(job, clock());
    const kind = KINDS[job.kind];
    const size = job.purgedAt ? null : await store.size(job.storageKey);
    if (size === null) return failClaimed(job, kind.gone, clock());
    if (job.kind === 'parse') {
      // Fornax would refuse a larger document only after the whole upload.
      const maxMb = await documentLimitMb(job);
      if (maxMb !== null && size > maxMb * 1024 * 1024) return failClaimed(job, `the document is larger than Fornax takes (${maxMb} MB)`, clock());
    }
    let submitted: FornaxJob;
    // A fresh stream for every attempt: a stream an attempt read cannot be sent again.
    const body = store.open(job.storageKey);
    // A read error reaches the client as a broken request ("Fornax is unreachable"): remember the real cause.
    let readError: NodeJS.ErrnoException | null = null;
    body.once('error', (e: NodeJS.ErrnoException) => {
      readError = e;
    });
    try {
      // The name carries the extension Fornax checks, not the user's file name.
      const name = job.storageKey.slice(job.storageKey.lastIndexOf('/') + 1);
      const file = await client.uploadFile(name, body, size, stopping.signal);
      const params = job.kind === 'parse'
        ? { ocr: 'auto' }
        : { diarize: true, ...(job.project ? { initial_prompt: [...job.project].slice(0, PROMPT_MAX).join('') } : {}) };
      submitted = await client.submit({ params, fileId: file.id, type: kind.type, input: kind.input }, stopping.signal);
    } catch (e) {
      // Stopped: the abort is no failure of Fornax and costs no attempt.
      if (stopping.signal.aborted && !(e instanceof FornaxError)) return release(job, clock());
      // The code only: the error's message holds the file's path on this host.
      if (e instanceof FornaxError && e.auth && !readError) return submitRefused(job, e, clock());
      const failure = readError
        ? new Error(`${WORDS[job.kind].unreadable} (${(readError as NodeJS.ErrnoException).code ?? 'read error'})`, { cause: e })
        : e;
      return submitFailed(job, failure, clock());
    } finally {
      body.destroy();
    }
    const now = clock();
    const saved = await db
      .update(reportJobs)
      .set({
        status: submitted.state === 'running' ? 'running' : 'queued', fornaxJobId: submitted.id, fornaxChange: submitted.change,
        note: submitted.note, ...progressOf(submitted), submitting: false, attempts: job.attempts + 1, error: null, startedAt: now, updatedAt: now,
      })
      .where(stillClaimed(job.id))
      .returning({ id: reportJobs.id });
    if (saved.length) log.info({ job: job.id, fornax: submitted.id }, `submitted a ${kind.what} to Fornax`);
    else log.warn({ job: job.id, fornax: submitted.id }, `${WORDS[job.kind].changed} changed while it was submitted to Fornax; its Fornax job is not followed`);
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
        log.error({ job: job.id, err: loggableError(e) }, `could not submit a ${KINDS[job.kind].what} to Fornax`);
      }
    }
  }

  /** The jobs Fornax works on: queued or running here, with a Fornax id. */
  const followedJobs = (): Promise<Followed[]> =>
    db
      .select({
        id: reportJobs.id, kind: reportJobs.kind, fornaxJobId: reportJobs.fornaxJobId, fornaxChange: reportJobs.fornaxChange, status: reportJobs.status,
        note: reportJobs.note, progress: reportJobs.progress, progressMessage: reportJobs.progressMessage,
      })
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

  /** Fornax finished: fetch the transcript or the text and store it, unless the job changed here meanwhile. */
  async function finish(job: Followed, seen: FornaxJob, now: Date, signal?: AbortSignal): Promise<void> {
    if (job.kind === 'parse') return finishDocument(job, seen, now, signal);
    let input: TranscriptInput;
    try {
      input = transcriptInput(await client.output(job.fornaxJobId, KINDS.transcribe.output, signal));
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

  /**
   * The text of a document: document.md as it came, with the counts and the model from its meta in Fornax's answer.
   * Only its first DOCUMENT_LIMITS.fileBytes are downloaded, as for a text file (more is cut when it is stored anyway).
   */
  async function finishDocument(job: Followed, seen: FornaxJob, now: Date, signal?: AbortSignal): Promise<void> {
    const output = KINDS.parse.output;
    let read: { text: string; truncated: boolean };
    try {
      read = await client.outputText(job.fornaxJobId, output, DOCUMENT_LIMITS.fileBytes, signal);
    } catch (e) {
      if (e instanceof FornaxError && e.permanent) return failFollowed(job, `the text of the document could not be fetched from Fornax: ${e.message}`, now);
      // Fornax unreachable: the next poll tries again.
      throw e;
    }
    const meta = documentMeta(seen.outputs?.find((o) => o.name === output)?.meta ?? null);
    try {
      const stored = await db.transaction(async (tx) => {
        const [row] = await tx.select({ id: reportJobs.id }).from(reportJobs).where(stillFollowed(job)).for('update');
        if (!row) return null;
        return storeParsedDocument(tx, job.id, { ...read, ...meta }, now);
      });
      // Never the text itself: only how long it is.
      if (stored) log.info({ job: job.id, fornax: job.fornaxJobId, characters: stored.characters }, 'stored the text of a document from Fornax');
    } catch (e) {
      if (e instanceof DomainError) return failFollowed(job, `the text from Fornax could not be stored: ${e.message}`, now);
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
        await finish(job, seen, now, signal);
        return false;
      case 'failed':
        await failFollowed(job, seen.error ?? 'the job failed in Fornax', now);
        return false;
      case 'canceled':
        await failFollowed(job, FORNAX_CANCELED, now);
        return false;
      default: {
        // Fornax's change value follows its exact progress, and not the note: the row is written only when what it
        // shows (state, the note, the whole percent, the progress message) changed. The change value itself only
        // needs to be current after a restart, where a stale one costs a single immediate answer.
        const shown = progressOf(seen);
        if (
          seen.state === job.status && seen.note === job.note
          && shown.progress === job.progress && shown.progressMessage === job.progressMessage
        ) {
          job.fornaxChange = seen.change;
          return true;
        }
        const [row] = await db
          .update(reportJobs)
          .set({ status: seen.state, note: seen.note, ...shown, fornaxChange: seen.change, updatedAt: now })
          .where(stillFollowed(job))
          .returning({ id: reportJobs.id });
        if (!row) return false;
        Object.assign(job, { status: seen.state, note: seen.note, ...shown, fornaxChange: seen.change });
        return true;
      }
    }
  }

  /** Fornax does not accept the token: the job keeps its state; a waiting job says why in its note. */
  async function followRefused(job: Followed, e: FornaxError, now: Date): Promise<void> {
    if (job.status !== 'queued') return;
    const note = cleanError(e.message);
    if (job.note === note) return;
    const [row] = await db.update(reportJobs).set({ note, updatedAt: now }).where(stillFollowed(job)).returning({ id: reportJobs.id });
    if (row) job.note = note;
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
        if (e instanceof FornaxError && e.auth) await followRefused(job, e, now);
        log.warn({ job: job.id, fornax: job.fornaxJobId, err: loggableError(e) }, `could not follow ${WORDS[job.kind].work} in Fornax; asking again later`);
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
    // One line per outage, not one every few seconds: the first failure, then the first round that works again.
    let failing = false;
    while (!signal.aborted) {
      try {
        const seen = await client.job(job.fornaxJobId, { wait: timing.waitS, ...(job.fornaxChange ? { change: job.fornaxChange } : {}), signal });
        const more = await apply(job, seen, new Date(), signal);
        if (failing) log.info({ job: job.id, fornax: job.fornaxJobId }, `following ${WORDS[job.kind].work} in Fornax works again`);
        failing = false;
        if (!more) return;
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof FornaxError && e.auth) await followRefused(job, e, new Date()).catch(() => {});
        if (!failing) {
          log.warn(
            { job: job.id, fornax: job.fornaxJobId, err: loggableError(e) },
            `could not follow ${WORDS[job.kind].work} in Fornax; asking again every few seconds (logged again once it works)`,
          );
        }
        failing = true;
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
        .catch((e: unknown) => log.error({ job: job.id, err: loggableError(e) }, `following ${WORDS[job.kind].work} in Fornax stopped`))
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
        // A submit the previous run of the server did not finish: nobody uploads it any more. This holds because Tabula
        // runs as a single server per database; a second server would see this one's uploads taken back.
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

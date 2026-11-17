import { Readable } from 'node:stream';
import type { FornaxConfig } from '../config.js';

export type { FornaxConfig };

export type FornaxJob = {
  id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  error: string | null;
  /** Changes whenever the job changes; passed back to `job()` to long-poll. */
  change: string;
  /** Why a queued job waits, one sentence (null in every other state). */
  note: string | null;
  /** Fornax reports a fraction 0..1 and a message: `done` is the fraction and `total` is 1. */
  progress: { done?: number; total?: number; message?: string } | null;
};

/**
 * A failed call to Fornax. `status` is null for a network error or a timeout; `permanent` means retrying cannot help;
 * `auth` is a 401 or 403 (a missing, unknown, revoked or not yet approved token): a configuration problem, never permanent.
 */
export class FornaxError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly permanent: boolean,
    readonly auth = false,
  ) {
    super(message);
    this.name = 'FornaxError';
  }
}

const CALL_TIMEOUT_MS = 60_000;
const LONG_POLL_MARGIN_S = 15;
// A recording of hours may be gigabytes; the upload has no 60 s limit.
const UPLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const STATES = new Set<unknown>(['queued', 'running', 'succeeded', 'failed', 'canceled'] satisfies FornaxJob['state'][]);

type WireJob = {
  id: string;
  state: FornaxJob['state'];
  error?: string | null;
  change: string;
  note?: string | null;
  progress?: number | null;
  progress_message?: string | null;
};

export function fornaxClient(cfg: FornaxConfig, fetchImpl: typeof fetch = fetch) {
  const base = cfg.url.replace(/\/+$/, '');
  // The token must not leak through any message, whatever the cause says.
  const scrub = (s: string) => (cfg.token ? s.split(cfg.token).join('***') : s);

  /** The answer of a successful call, parsed as JSON. Reading or parsing it fails like the call itself would. */
  async function call(
    method: string,
    path: string,
    init: { body?: BodyInit; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; duplex?: boolean } = {},
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? CALL_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${cfg.token}`, ...init.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.duplex ? { duplex: 'half' } : {}),
        signal,
      } as RequestInit);
    } catch (e) {
      // The caller's own abort is not a Fornax failure.
      if (init.signal?.aborted) throw e;
      if (timeout.aborted) throw new FornaxError('Fornax did not answer in time', null, false);
      const cause = (e as { cause?: { code?: string } }).cause;
      throw new FornaxError(scrub(`Fornax is unreachable${cause?.code ? ` (${cause.code})` : ''}`), null, false);
    }
    if (!res.ok) throw await failure(res);
    // The body arrives after the headers: it can still time out, break off, or be a proxy's page instead of JSON.
    try {
      return await res.json();
    } catch (e) {
      if (init.signal?.aborted) throw e;
      if (timeout.aborted) throw new FornaxError('Fornax did not answer in time', null, false);
      if (e instanceof SyntaxError) throw new FornaxError('Fornax answered with something other than JSON', null, false);
      throw new FornaxError('the answer from Fornax broke off', null, false);
    }
  }

  async function failure(res: Response): Promise<FornaxError> {
    let message = '';
    let code: unknown = null;
    try {
      const body = (await res.json()) as { error?: unknown; message?: unknown } | null;
      if (typeof body?.message === 'string') message = body.message;
      code = body?.error ?? null;
    } catch {
      // not JSON: use the status
    }
    // The token is not accepted (yet): that is no fault of the recording or the job, and an admin can fix it.
    if (res.status === 401 || res.status === 403) {
      return new FornaxError(scrub(message || "Fornax refused Tabula's token"), res.status, false, true);
    }
    // A 404 is Fornax's own answer only with its JSON error body; a proxy's 404 page (e.g. while Fornax restarts)
    // passes, so it is not taken for "Fornax does not know this job".
    const permanent = res.status === 404
      ? code === 'not_found'
      : res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    return new FornaxError(scrub(message ? `Fornax answered ${res.status}: ${message}` : `Fornax answered ${res.status}`), res.status, permanent);
  }

  const unexpected = () => new FornaxError('Fornax sent an answer of an unexpected shape', null, false);
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

  const toJob = (body: unknown): FornaxJob => {
    if (!isObject(body) || typeof body.id !== 'string' || !STATES.has(body.state) || typeof body.change !== 'string') throw unexpected();
    const w = body as WireJob;
    const hasProgress = w.progress != null || w.progress_message != null;
    return {
      id: w.id,
      state: w.state,
      error: w.error ?? null,
      change: w.change,
      note: w.note ?? null,
      progress: hasProgress
        ? {
            ...(w.progress != null ? { done: w.progress, total: 1 } : {}),
            ...(w.progress_message != null ? { message: w.progress_message } : {}),
          }
        : null,
    };
  };

  return {
    async uploadFile(name: string, body: Readable | ReadableStream, size: number, signal?: AbortSignal): Promise<{ id: string }> {
      const stream = body instanceof Readable ? (Readable.toWeb(body) as ReadableStream) : body;
      const answer = await call('POST', `/api/files?name=${encodeURIComponent(name)}`, {
        body: stream as unknown as BodyInit,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
        duplex: true,
        timeoutMs: UPLOAD_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      if (!isObject(answer) || typeof answer.id !== 'string') throw unexpected();
      return { id: answer.id };
    },

    async submit(input: { params: Record<string, unknown>; fileId: string }, signal?: AbortSignal): Promise<FornaxJob> {
      const body = await call('POST', '/api/jobs', {
        body: JSON.stringify({
          type: 'transcribe', params: input.params, inputs: { audio: input.fileId }, priority: cfg.priority, group: 'tabula',
        }),
        headers: { 'content-type': 'application/json' },
        ...(signal ? { signal } : {}),
      });
      return toJob(body);
    },

    /** The job, or null when Fornax does not know it (its own 404; also another client's job). */
    async job(id: string, opts: { wait?: number; change?: string; signal?: AbortSignal } = {}): Promise<FornaxJob | null> {
      const q = new URLSearchParams();
      if (opts.wait !== undefined) q.set('wait', String(opts.wait));
      if (opts.change !== undefined) q.set('change', opts.change);
      const qs = q.size ? `?${q}` : '';
      try {
        const body = await call('GET', `/api/jobs/${encodeURIComponent(id)}${qs}`, {
          timeoutMs: opts.wait ? (opts.wait + LONG_POLL_MARGIN_S) * 1000 : CALL_TIMEOUT_MS,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        return toJob(body);
      } catch (e) {
        if (e instanceof FornaxError && e.status === 404 && e.permanent) return null;
        throw e;
      }
    },

    /** An output of a finished job, parsed as JSON. */
    async output(id: string, name: string, signal?: AbortSignal): Promise<unknown> {
      return call('GET', `/api/jobs/${encodeURIComponent(id)}/outputs/${encodeURIComponent(name)}`, signal ? { signal } : {});
    },

    /** Whether the Fornax worker is online and offers `transcribe` (GET /api/types). */
    async status(): Promise<{ online: boolean; offered: boolean }> {
      const body = await call('GET', '/api/types');
      if (!isObject(body)) throw unexpected();
      const { types, worker } = body as { types?: unknown; worker?: { online?: unknown } | null };
      return {
        online: isObject(worker) && worker.online === true,
        offered: Array.isArray(types) && types.some((t) => isObject(t) && t.name === 'transcribe'),
      };
    },
  };
}

export type FornaxClient = ReturnType<typeof fornaxClient>;

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

/** A failed call to Fornax. `status` is null for a network error or a timeout; `permanent` means retrying cannot help. */
export class FornaxError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'FornaxError';
  }
}

const CALL_TIMEOUT_MS = 60_000;
const LONG_POLL_MARGIN_S = 15;
// A recording of hours may be gigabytes; the upload has no 60 s limit.
const UPLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;

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

  async function call(
    method: string,
    path: string,
    init: { body?: BodyInit; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; duplex?: boolean } = {},
  ): Promise<Response> {
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
    if (res.ok) return res;
    throw await failure(res);
  }

  async function failure(res: Response): Promise<FornaxError> {
    let message = '';
    try {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // not JSON: use the status
    }
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    return new FornaxError(scrub(message ? `Fornax answered ${res.status}: ${message}` : `Fornax answered ${res.status}`), res.status, permanent);
  }

  const toJob = (w: WireJob): FornaxJob => {
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
    async uploadFile(name: string, body: Readable | ReadableStream, size: number): Promise<{ id: string }> {
      const stream = body instanceof Readable ? (Readable.toWeb(body) as ReadableStream) : body;
      const res = await call('POST', `/api/files?name=${encodeURIComponent(name)}`, {
        body: stream as unknown as BodyInit,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
        duplex: true,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      return { id: ((await res.json()) as { id: string }).id };
    },

    async submit(input: { params: Record<string, unknown>; fileId: string }): Promise<FornaxJob> {
      const res = await call('POST', '/api/jobs', {
        body: JSON.stringify({
          type: 'transcribe', params: input.params, inputs: { audio: input.fileId }, priority: cfg.priority, group: 'tabula',
        }),
        headers: { 'content-type': 'application/json' },
      });
      return toJob((await res.json()) as WireJob);
    },

    /** The job, or null when Fornax does not know it (404; also another client's job). */
    async job(id: string, opts: { wait?: number; change?: string; signal?: AbortSignal } = {}): Promise<FornaxJob | null> {
      const q = new URLSearchParams();
      if (opts.wait !== undefined) q.set('wait', String(opts.wait));
      if (opts.change !== undefined) q.set('change', opts.change);
      const qs = q.size ? `?${q}` : '';
      try {
        const res = await call('GET', `/api/jobs/${encodeURIComponent(id)}${qs}`, {
          timeoutMs: opts.wait ? (opts.wait + LONG_POLL_MARGIN_S) * 1000 : CALL_TIMEOUT_MS,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        return toJob((await res.json()) as WireJob);
      } catch (e) {
        if (e instanceof FornaxError && e.status === 404) return null;
        throw e;
      }
    },

    /** An output of a finished job, parsed as JSON. */
    async output(id: string, name: string): Promise<unknown> {
      const res = await call('GET', `/api/jobs/${encodeURIComponent(id)}/outputs/${encodeURIComponent(name)}`);
      return res.json();
    },

    /** Whether the Fornax worker is online and offers `transcribe` (GET /api/types). */
    async status(): Promise<{ online: boolean; offered: boolean }> {
      const res = await call('GET', '/api/types');
      const body = (await res.json()) as { types?: { name: string }[]; worker?: { online?: boolean } };
      return { online: body.worker?.online === true, offered: (body.types ?? []).some((t) => t.name === 'transcribe') };
    },
  };
}

import type { FornaxClient } from './client.js';

export type FornaxStatus = { online: boolean | null; offered: boolean | null };

const UNKNOWN: FornaxStatus = { online: null, offered: null };

/**
 * Whether the Fornax worker is online and offers `transcribe`, for the status route. The answer is cached for 30 s
 * (also when Fornax could not be reached) and a call never waits longer than `timeoutMs`, so the page's indicator
 * cannot hang on a slow or dead Fornax. Several requests at once share one call.
 */
export function createStatusCache(client: Pick<FornaxClient, 'status'>, opts: { ttlMs?: number; timeoutMs?: number; now?: () => number } = {}) {
  const ttlMs = opts.ttlMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const now = opts.now ?? Date.now;
  let cached: { at: number; value: FornaxStatus } | null = null;
  let pending: Promise<FornaxStatus> | null = null;

  const fetchOnce = async (): Promise<FornaxStatus> => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<FornaxStatus>((resolve) => {
      timer = setTimeout(() => resolve(UNKNOWN), timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([client.status().then((s): FornaxStatus => ({ online: s.online, offered: s.offered })), timedOut]);
    } catch {
      return UNKNOWN;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async get(): Promise<FornaxStatus> {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      pending ??= fetchOnce().then((value) => {
        cached = { at: now(), value };
        return value;
      }).finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}

import type { FastifyRequest } from 'fastify';

/** Per-key counts in fixed windows, in memory (one process, one owner). The oldest key is forgotten past maxKeys. */
export class FixedWindows {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly windowMs: number, private readonly maxKeys = 10_000) {}

  /** The count in the current window, without adding to it. */
  count(key: string, now: number): number {
    const w = this.windows.get(key);
    return w && now - w.start < this.windowMs ? w.count : 0;
  }

  /** Adds one attempt and returns the count including it. */
  add(key: string, now: number): number {
    const cur = this.windows.get(key);
    const next = cur && now - cur.start < this.windowMs ? { start: cur.start, count: cur.count + 1 } : { start: now, count: 1 };
    this.windows.delete(key);
    this.windows.set(key, next);
    if (this.windows.size > this.maxKeys) this.windows.delete(this.windows.keys().next().value!);
    return next.count;
  }
}

/**
 * Who is asking, for the per-address limits. Behind the reverse proxy every connection comes from the proxy, so the
 * address is the last X-Forwarded-For entry, the one the nearest proxy added (Caddy replaces a header sent by an
 * untrusted client). Without the header: the socket's address.
 */
export function clientKey(req: FastifyRequest): string {
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  const last = raw?.split(',').map((s) => s.trim()).filter(Boolean).pop();
  return last ?? req.socket.remoteAddress ?? 'unknown';
}

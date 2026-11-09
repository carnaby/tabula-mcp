import { DrizzleQueryError } from 'drizzle-orm';

export type ErrorCode = 'bad_request' | 'forbidden' | 'not_found' | 'conflict' | 'too_large' | 'unavailable';

const STATUS: Record<ErrorCode, number> = { bad_request: 400, forbidden: 403, not_found: 404, conflict: 409, too_large: 413, unavailable: 503 };

export class DomainError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
  }
  get status(): number {
    return STATUS[this.code];
  }
}

export const badRequest = (m: string) => new DomainError('bad_request', m);
export const forbidden = (m: string) => new DomainError('forbidden', m);
export const notFound = (m: string) => new DomainError('not_found', m);
export const conflict = (m: string) => new DomainError('conflict', m);
export const tooLarge = (m: string) => new DomainError('too_large', m);
export const unavailable = (m: string) => new DomainError('unavailable', m);

export const AGENT_READ_ONLY = 'human-authored records are read-only for agents';

/** Fields of database errors that hold the values of a query (transcript text, file contents, note bodies). */
const VALUE_FIELDS = new Set(['params', 'parameters', 'args', 'detail']);

/**
 * An error as it may go to the log. drizzle's DrizzleQueryError puts the query's parameters into its message, its
 * stack and a `params` field, and Postgres repeats a refused row in `detail`; anywhere in the cause chain such an
 * error is replaced by a copy with the SQL only. Errors without these come back unchanged.
 */
export function loggableError(err: unknown, depth = 0): unknown {
  if (!(err instanceof Error) || depth > 8) return err;
  const cause = loggableError(err.cause, depth + 1);
  const query = err instanceof DrizzleQueryError ? err.query : null;
  if (query === null && cause === err.cause && !Object.keys(err).some((k) => VALUE_FIELDS.has(k))) return err;
  const copy = Object.create(Object.getPrototypeOf(err) as object) as Error;
  for (const [k, v] of Object.entries(err)) {
    if (!VALUE_FIELDS.has(k) && k !== 'cause') (copy as unknown as Record<string, unknown>)[k] = v;
  }
  const message = query === null ? err.message : `Failed query: ${query}`;
  // The stack starts with "<name>: <message>"; only the frames after it are kept when the message changes.
  const head = `${err.name}: ${err.message}`;
  const frames = err.stack?.startsWith(head) ? err.stack.slice(head.length) : '';
  const stack = query === null ? err.stack : `${err.name}: ${message}${frames}`;
  Object.defineProperty(copy, 'message', { value: message, writable: true, configurable: true });
  Object.defineProperty(copy, 'stack', { value: stack, writable: true, configurable: true });
  if (cause !== undefined) Object.defineProperty(copy, 'cause', { value: cause, writable: true, configurable: true });
  return copy;
}

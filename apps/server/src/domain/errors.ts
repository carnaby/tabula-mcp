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

/** A file type Tabula does not store. A 400 for /api, which always answered it so; the App API names it 415. */
export class UnsupportedMediaError extends DomainError {
  constructor(message: string) {
    super('bad_request', message);
    this.name = 'UnsupportedMediaError';
  }
}
export const unsupportedMedia = (m: string) => new UnsupportedMediaError(m);

export const AGENT_READ_ONLY = 'human-authored records are read-only for agents';

export const NUL_REFUSED = 'a value contains a character that cannot be stored (such as a NUL character)';

/** SQLSTATEs of a value Postgres cannot store: 22021 an invalid byte sequence (a NUL in text), 22P05 a NUL in jsonb. */
const UNSTORABLE_CHARACTER = new Set(['22021', '22P05']);

/** Postgres refused a character in a value (a NUL above all), directly or as the cause drizzle wraps it in. */
export function isNulRefusal(e: unknown): boolean {
  for (let x = e, depth = 0; x && depth < 5; x = (x as { cause?: unknown }).cause, depth++) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === 'string' && UNSTORABLE_CHARACTER.has(code)) return true;
  }
  return false;
}

/**
 * Fields of database errors that hold the values of a query (transcript text, file contents, note bodies). `where`
 * is Postgres's context, which quotes the start of a refused jsonb value.
 */
const VALUE_FIELDS = new Set(['params', 'parameters', 'args', 'detail', 'where']);

/**
 * An error as it may go to the log. drizzle's DrizzleQueryError puts the query's parameters into its message, its
 * stack and a `params` field, and Postgres repeats a refused row in `detail` and a refused jsonb value in `where`;
 * anywhere in the cause chain such an error is replaced by a copy with the SQL only. Errors without these come back
 * unchanged.
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

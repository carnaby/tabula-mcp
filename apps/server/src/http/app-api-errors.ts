import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { DomainError, isNulRefusal, loggableError, NUL_REFUSED, UnsupportedMediaError } from '../domain/errors.js';

/**
 * The error codes of the App API (spec §6): the code is the contract, the message is not. `unavailable` (503, media
 * storage down) is an addition to the spec's list: `internal` would hide that a retry later can succeed.
 */
export type AppErrorCode =
  | 'unauthorized' | 'validation_failed' | 'project_not_found' | 'report_not_found' | 'not_found' | 'report_closed'
  | 'request_in_progress' | 'too_large' | 'unsupported_media_type' | 'idempotency_key_reused' | 'unavailable' | 'internal';

/** One refused input: `path` names the field or header, or is empty when the rule concerns the request as a whole. */
export type Issue = { path: string; message: string };

export class AppApiError extends Error {
  constructor(readonly status: number, readonly code: AppErrorCode, message: string, readonly issues?: Issue[]) {
    super(message);
    this.name = 'AppApiError';
  }
}

export const validationFailed = (issues: Issue[]): AppApiError =>
  new AppApiError(400, 'validation_failed', issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '), issues);

/** zod's issues as the API reports them: an unknown field is one issue named by its path. */
export function zodIssues(error: z.ZodError): Issue[] {
  return error.issues.flatMap((i): Issue[] =>
    i.code === 'unrecognized_keys'
      ? i.keys.map((key) => ({ path: [...i.path, key].map(String).join('.'), message: 'unknown field' }))
      : [{ path: i.path.map(String).join('.'), message: i.message }],
  );
}

/** Request input checked against a schema; an absent body counts as {}. */
export function parseBody<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw validationFailed(zodIssues(r.error));
  return r.data;
}

/** A domain refusal under the code an endpoint promises for it, e.g. not_found → report_not_found. */
export function translate(e: unknown, codes: { not_found?: AppErrorCode; conflict?: AppErrorCode }): unknown {
  if (!(e instanceof DomainError) || e instanceof UnsupportedMediaError) return e;
  const code = e.code === 'not_found' ? codes.not_found : e.code === 'conflict' ? codes.conflict : undefined;
  return code ? new AppApiError(e.status, code, e.message) : e;
}

/** Any error as the App API answers it; nothing about an unexpected one leaves the server. */
export function toAppError(err: unknown): AppApiError {
  if (err instanceof AppApiError) return err;
  if (err instanceof UnsupportedMediaError) return new AppApiError(415, 'unsupported_media_type', err.message);
  if (err instanceof DomainError) {
    if (err.code === 'bad_request') return validationFailed([{ path: '', message: err.message }]);
    if (err.code === 'too_large') return new AppApiError(413, 'too_large', err.message);
    if (err.code === 'unavailable') return new AppApiError(503, 'unavailable', err.message);
    // not_found, forbidden and conflict: an endpoint that expects one translates it into its own code (`not_found`
    // promises only an unknown path), so one that arrives here untranslated is unexpected.
    return new AppApiError(500, 'internal', 'internal error');
  }
  if (isNulRefusal(err)) return validationFailed([{ path: '', message: NUL_REFUSED }]);
  // Fastify's own refusals of a body: invalid or empty JSON (400), too large (413), not JSON (415).
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status === 413) return new AppApiError(413, 'too_large', 'the request body is too large');
  if (status === 415) return new AppApiError(415, 'unsupported_media_type', 'send the body as application/json');
  if (status >= 400 && status < 500) return validationFailed([{ path: '', message: (err as Error).message }]);
  return new AppApiError(500, 'internal', 'internal error');
}

export const errorBody = (e: AppApiError) => ({ error: e.code, message: e.message, ...(e.issues && { issues: e.issues }) });

/** What reaches the log: a cause, a refused character or an unexpected error, never a value of the request. */
export function logAppError(req: FastifyRequest, err: unknown, e: AppApiError): void {
  if (err instanceof DomainError && err.cause) req.log[e.status >= 500 ? 'error' : 'warn']({ err: loggableError(err.cause) }, err.message);
  else if (isNulRefusal(err)) req.log.warn({ err: loggableError(err) }, NUL_REFUSED);
  else if (e.status >= 500) req.log.error({ err: loggableError(err) }, 'App API request failed');
}

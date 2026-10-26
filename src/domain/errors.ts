export type ErrorCode = 'bad_request' | 'forbidden' | 'not_found' | 'conflict' | 'too_large';

const STATUS: Record<ErrorCode, number> = { bad_request: 400, forbidden: 403, not_found: 404, conflict: 409, too_large: 413 };

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

export const AGENT_READ_ONLY = 'human-authored records are read-only for agents';

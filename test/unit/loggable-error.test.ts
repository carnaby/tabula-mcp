import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { DomainError, loggableError } from '../../src/domain/errors.js';

/** Shaped like postgres.js's PostgresError: the refused row is repeated in `detail`. */
class PostgresError extends Error {
  code = '23514';
  detail = 'Failing row contains (secret words).';
  constraint_name = 'refuse_all';
}

describe('loggableError', () => {
  it('keeps the SQL of a failed query but not its values, anywhere in the cause chain', () => {
    const pg = new PostgresError('new row violates check constraint "refuse_all"');
    const query = new DrizzleQueryError('insert into t (a) values ($1)', ['secret words'], pg);
    const outer = new DomainError('unavailable', 'could not store it');
    outer.cause = query;

    const safe = loggableError(outer) as Error;
    const text = JSON.stringify(safe, Object.getOwnPropertyNames(safe)) + String(safe.stack) + JSON.stringify(Object.entries(safe));
    expect(safe).toBeInstanceOf(DomainError);
    expect(safe.message).toBe('could not store it');
    const q = safe.cause as Error & Record<string, unknown>;
    expect(q.message).toBe('Failed query: insert into t (a) values ($1)');
    expect(q.stack).toMatch(/^Error: Failed query: insert into t \(a\) values \(\$1\)\n\s+at /);
    expect(q.params).toBeUndefined();
    expect(q.query).toBe('insert into t (a) values ($1)');
    const p = q.cause as PostgresError;
    expect(p).toBeInstanceOf(PostgresError);
    expect(p).toMatchObject({ message: 'new row violates check constraint "refuse_all"', code: '23514', constraint_name: 'refuse_all' });
    expect(p.detail).toBeUndefined();
    expect(text + JSON.stringify(Object.entries(q)) + String(q.stack)).not.toContain('secret');
    // The original errors are not changed.
    expect(query.params).toEqual(['secret words']);
    expect(pg.detail).toContain('secret');
  });

  it('returns other errors and non-errors unchanged', () => {
    const plain = new Error('disk full', { cause: new Error('ENOSPC') });
    expect(loggableError(plain)).toBe(plain);
    expect(loggableError('text')).toBe('text');
    expect(loggableError(undefined)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { refOf, refQuery } from '../../src/shared/refs.js';

const ID = 'd86d86e7-1234-4000-8000-000000000000';

describe('refOf', () => {
  it('is tabula: and the first 8 characters of the id, lowercase', () => {
    expect(refOf(ID)).toBe('tabula:d86d86e7');
    expect(refOf(ID.toUpperCase())).toBe('tabula:d86d86e7');
  });
});

describe('refQuery', () => {
  it('normalizes a query that is a whole reference', () => {
    expect(refQuery('tabula:d86d86e7')).toBe('tabula:d86d86e7');
    expect(refQuery('TABULA:D86D86E7')).toBe('tabula:d86d86e7');
    expect(refQuery('  tabula: d86d86e7 ')).toBe('tabula:d86d86e7');
    expect(refQuery('tabula:d86d')).toBe('tabula:d86d');
    expect(refQuery(`tabula:${ID}`)).toBe(`tabula:${ID}`);
  });

  it('accepts what a reference picks up when it is copied out of a chat', () => {
    expect(refQuery('`tabula:d86d86e7`')).toBe('tabula:d86d86e7');
    expect(refQuery('"tabula:d86d86e7".')).toBe('tabula:d86d86e7');
    expect(refQuery('“tabula:d86d86e7”,')).toBe('tabula:d86d86e7');
  });

  it('strips the Markdown a chat wraps a reference in', () => {
    for (const q of ['(tabula:d86d86e7)', '[tabula:d86d86e7]', '<tabula:d86d86e7>', '**tabula:d86d86e7**', '_tabula:d86d86e7_', '*`tabula:d86d86e7`*', '(tabula:d86d86e7).', '**`TABULA:D86D86E7`**,']) {
      expect(refQuery(q), q).toBe('tabula:d86d86e7');
    }
    expect(refQuery('(tabula:d86d)')).toBe('tabula:d86d');
    expect(refQuery(`<tabula:${ID.replace(/-/g, '')}>`)).toBe(`tabula:${ID.replace(/-/g, '')}`);
    expect(refQuery(`(tabula:${ID.replace(/-/g, '')}0)`)).toBeNull();
  });

  it('is null for anything that is not only a reference', () => {
    for (const q of ['', 'd86d86e7', '#d86d', 'tabula:', 'tabula:abc', 'tabula:----', 'tabula:xyz12345', 'see tabula:d86d86e7', 'tabula:d86d86e7 and more', '[tabula:d86d86e7](https://example.com)', '(tabula:)', 'tabula:d86d86e7)x']) {
      expect(refQuery(q), q).toBeNull();
    }
  });
});

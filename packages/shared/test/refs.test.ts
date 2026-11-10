import { describe, expect, it } from 'vitest';
import { findRef, refOf, refQuery, splitRefs } from '../src/refs.js';

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

describe('splitRefs', () => {
  const R = (ref: string) => ({ ref });

  it('finds a reference in a sentence and lowercases it', () => {
    expect(splitRefs('see tabula:d86d86e7 now')).toEqual(['see ', R('tabula:d86d86e7'), ' now']);
    expect(splitRefs('TABULA:D86D86E7')).toEqual([R('tabula:d86d86e7')]);
  });

  it('allows punctuation around it', () => {
    expect(splitRefs('(tabula:d86d86e7).')).toEqual(['(', R('tabula:d86d86e7'), ').']);
    expect(splitRefs('tabula:d86d86e7, tabula:00000000')).toEqual([R('tabula:d86d86e7'), ', ', R('tabula:00000000')]);
  });

  it('ignores a reference glued to a word on the left', () => {
    expect(splitRefs('xtabula:12345678')).toEqual(['xtabula:12345678']);
    expect(splitRefs('_tabula:12345678')).toEqual(['_tabula:12345678']);
  });

  it('ignores more hex or word characters after it (a full uuid is not a short reference)', () => {
    expect(splitRefs('tabula:123456789')).toEqual(['tabula:123456789']);
    expect(splitRefs('tabula:12345678abc')).toEqual(['tabula:12345678abc']);
    expect(splitRefs(`tabula:${ID}`)).toEqual([`tabula:${ID}`]);
  });

  it('ignores too short or non-hex ids', () => {
    expect(splitRefs('tabula:d86d')).toEqual(['tabula:d86d']);
    expect(splitRefs('tabula:ghijklmn')).toEqual(['tabula:ghijklmn']);
  });

  it('returns plain text as one piece and nothing for empty text', () => {
    expect(splitRefs('no refs here')).toEqual(['no refs here']);
    expect(splitRefs('')).toEqual([]);
  });

  it('can be called repeatedly (no shared regex state)', () => {
    expect(splitRefs('tabula:d86d86e7')).toEqual(splitRefs('tabula:d86d86e7'));
  });
});

describe('findRef', () => {
  it('gives the index and length of the first reference', () => {
    expect(findRef('ab tabula:D86D86E7 cd')).toEqual({ index: 3, length: 15, ref: 'tabula:d86d86e7' });
    expect(findRef('nothing')).toBeNull();
  });
});

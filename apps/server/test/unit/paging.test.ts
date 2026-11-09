import { describe, expect, it } from 'vitest';
import { pageWindow, prefixTsQuery, usesWebsearchSyntax } from '../../src/domain/paging.js';

describe('prefixTsQuery', () => {
  it('turns words into prefix terms joined by AND, keeping Slovak letters', () => {
    expect(prefixTsQuery('Drizz  pri')).toBe('drizz:* & pri:*');
    expect(prefixTsQuery('ťažká úloha')).toBe('ťažká:* & úloha:*');
  });
  it('keeps combining marks of decomposed letters (NFC-normalized)', () => {
    expect(prefixTsQuery('cafe\u0301')).toBe('caf\u00e9:*');
    expect(prefixTsQuery('cafe\u0301 au')).toBe('caf\u00e9:* & au:*');
  });
  it('drops tsquery syntax so user input can never break the query', () => {
    expect(prefixTsQuery("a:* & !(b | 'c')")).toBe('a:* & b:* & c:*');
    expect(prefixTsQuery('  !&| ')).toBeUndefined();
    expect(prefixTsQuery(undefined)).toBeUndefined();
  });
});

describe('pageWindow', () => {
  it('clamps page and size', () => {
    expect(pageWindow({})).toEqual({ page: 1, pageSize: 25, limit: 25, offset: 0 });
    expect(pageWindow({ page: 3, pageSize: 10 })).toMatchObject({ offset: 20, limit: 10 });
    expect(pageWindow({ page: -2, pageSize: 1000 })).toMatchObject({ page: 1, pageSize: 100 });
  });
});

describe('usesWebsearchSyntax', () => {
  it('is true for quoted phrases, OR and -exclusion', () => {
    for (const q of ['"graficka mapa"', 'foo "bar', 'alpha OR beta', 'alpha or beta', 'cache -redis', '-redis cache']) {
      expect(usesWebsearchSyntax(q), q).toBe(true);
    }
  });
  it('is false for plain words, hyphenated words and a lone hyphen', () => {
    for (const q of ['projekt', 'poznam projekt', 'e-mail', 'orchester', 'color', 'a - b', 'x-', '']) {
      expect(usesWebsearchSyntax(q), q).toBe(false);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { pageWindow, prefixTsQuery } from '../../src/domain/paging.js';

describe('prefixTsQuery', () => {
  it('turns words into prefix terms joined by AND, keeping Slovak letters', () => {
    expect(prefixTsQuery('Drizz  pri')).toBe('drizz:* & pri:*');
    expect(prefixTsQuery('ťažká úloha')).toBe('ťažká:* & úloha:*');
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

import { describe, expect, it } from 'vitest';
import { parseIdRef, shortIds } from '../../src/domain/ids.js';

const A = 'a1f3c2d4-0000-4000-8000-000000000001';
const B = 'a1f3ffff-0000-4000-8000-000000000002';
const C = 'b7c01234-0000-4000-8000-000000000003';

describe('parseIdRef', () => {
  it('parses a full uuid', () => expect(parseIdRef(A.toUpperCase())).toEqual({ kind: 'full', id: A }));
  it('parses a #prefix as the old short form', () => expect(parseIdRef('#a1f3')).toEqual({ kind: 'prefix', prefix: 'a1f3', legacy: true }));
  it('parses a bare prefix with dashes as hex', () => expect(parseIdRef('a1f3c2d4-00')).toEqual({ kind: 'prefix', prefix: 'a1f3c2d400', legacy: true }));
  it('parses tabula: references in any case, with spaces and dashes', () => {
    expect(parseIdRef('tabula:a1f3c2d4')).toEqual({ kind: 'prefix', prefix: 'a1f3c2d4', legacy: false });
    expect(parseIdRef(' TABULA: A1F3 ')).toEqual({ kind: 'prefix', prefix: 'a1f3', legacy: false });
    expect(parseIdRef('tabula:a1f3c2d4-0000-4')).toEqual({ kind: 'prefix', prefix: 'a1f3c2d400004', legacy: false });
  });
  it('turns a reference with all 32 hex characters into the full uuid, with or without dashes', () => {
    expect(parseIdRef(`tabula:${A}`)).toEqual({ kind: 'full', id: A });
    expect(parseIdRef(`tabula:${A.replace(/-/g, '')}`)).toEqual({ kind: 'full', id: A });
  });
  it('rejects too short or non-hex', () => {
    expect(() => parseIdRef('a1f')).toThrow(/first 4\+ hex characters/);
    expect(() => parseIdRef('zzzz')).toThrow(/first 4\+ hex characters/);
    expect(() => parseIdRef('tabula:a1f')).toThrow(/tabula:a1f3c2d4/);
    expect(() => parseIdRef('tabula:')).toThrow(/tabula:a1f3c2d4/);
  });
});

describe('shortIds', () => {
  it('uses 4 chars when unique', () => {
    expect(shortIds([A, C])).toEqual(new Map([[A, 'a1f3'], [C, 'b7c0']]));
  });
  it('extends length until all are unique', () => {
    const m = shortIds([A, B, C]);
    expect(m.get(A)).toBe('a1f3c');
    expect(m.get(B)).toBe('a1f3f');
    expect(m.get(C)).toBe('b7c01');
  });
});

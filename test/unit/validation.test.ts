import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import {
  normalizeTags, sanitizeAgentLabel, validateMemoryText, validateNoteText, validateProjectSlug,
} from '../../src/domain/validation.js';

const fails = (fn: () => unknown, re: RegExp) => {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).status).toBe(400);
    expect((e as Error).message).toMatch(re);
    return;
  }
  throw new Error('expected DomainError');
};

describe('validateMemoryText', () => {
  it('trims and accepts valid input', () => {
    expect(validateMemoryText({ title: '  Use pnpm  ', body: ' Because. ' })).toEqual({ title: 'Use pnpm', body: 'Because.' });
  });
  it('counts characters, not UTF-16 units', () => {
    expect(() => validateMemoryText({ title: 'č'.repeat(120), body: 'b' })).not.toThrow();
  });
  it('rejects empty title', () => fails(() => validateMemoryText({ title: ' ', body: 'b' }), /title must not be empty/));
  it('rejects multi-line title', () => fails(() => validateMemoryText({ title: 'a\nb', body: 'b' }), /single line/));
  it('rejects long title with its length', () => fails(() => validateMemoryText({ title: 'x'.repeat(121), body: 'b' }), /121 characters; the limit is 120/));
  it('rejects empty body', () => fails(() => validateMemoryText({ title: 't', body: '  ' }), /body must not be empty/));
  it('rejects long body', () => fails(() => validateMemoryText({ title: 't', body: 'x'.repeat(2001) }), /2001 characters; the limit is 2000/));
  it('rejects NUL in title', () => fails(() => validateMemoryText({ title: 'a\u0000b', body: 'b' }), /title must not contain NUL characters/));
  it('rejects NUL in body', () => fails(() => validateMemoryText({ title: 't', body: 'a\u0000b' }), /body must not contain NUL characters/));
});

describe('validateNoteText', () => {
  it('rejects long summary', () => fails(() => validateNoteText({ title: 't', summary: 'x'.repeat(201) }), /summary/));
  it('rejects empty title', () => fails(() => validateNoteText({ title: '', summary: '' }), /title must not be empty/));
  it('rejects NUL in title', () => fails(() => validateNoteText({ title: 'a\u0000b', summary: '' }), /title must not contain NUL characters/));
  it('rejects NUL in summary', () => fails(() => validateNoteText({ title: 't', summary: 'a\u0000b' }), /summary must not contain NUL characters/));
});

describe('normalizeTags', () => {
  it('lowercases, trims, drops empty and dedupes', () => {
    expect(normalizeTags([' DB ', 'db', '', 'Postgres'])).toEqual(['db', 'postgres']);
  });
  it('handles undefined', () => expect(normalizeTags(undefined)).toEqual([]));
});

describe('sanitizeAgentLabel', () => {
  it('keeps a clean label lowercased', () => expect(sanitizeAgentLabel('Claude-Code')).toBe('claude-code'));
  it('falls back to unknown', () => {
    expect(sanitizeAgentLabel(undefined)).toBe('unknown');
    expect(sanitizeAgentLabel('bad label!')).toBe('unknown');
    expect(sanitizeAgentLabel(['a', 'b'])).toBe('unknown');
  });
  it('never lets an agent pose as the human', () => {
    expect(sanitizeAgentLabel('human')).toBe('unknown');
    expect(sanitizeAgentLabel(' Human ')).toBe('unknown');
    expect(sanitizeAgentLabel('humans')).toBe('humans');
  });
});

describe('validateProjectSlug', () => {
  it('accepts lowercase slugs', () => expect(validateProjectSlug('acme')).toBe('acme'));
  it('rejects uppercase and spaces', () => fails(() => validateProjectSlug('My Project'), /slug/));
});

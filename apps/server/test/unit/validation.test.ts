import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import {
  isAgentLabel, normalizeModel, normalizeTags, validateMemoryText, validateNoteText, validateProjectSlug,
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

describe('validateProjectSlug', () => {
  it('accepts lowercase slugs', () => expect(validateProjectSlug('acme')).toBe('acme'));
  it('rejects uppercase and spaces', () => fails(() => validateProjectSlug('My Project'), /slug/));
  it('reserves "none" for reports without a project', () => fails(() => validateProjectSlug('none'), /"none" is reserved/));
});

describe('normalizeModel', () => {
  it('lower-cases, turns any other character into a dash and keeps at most 60', () => {
    expect(normalizeModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(normalizeModel('Claude Opus 5.5')).toBe('claude-opus-5.5');
    expect(normalizeModel('  gemini/2.5 pro (preview) ')).toBe('gemini-2.5-pro-preview');
    expect(normalizeModel('x'.repeat(80))).toHaveLength(60);
  });

  it('is "unknown" when nothing usable is left', () => {
    for (const nothing of ['', '   ', '!!!', undefined, null, 42]) expect(normalizeModel(nothing)).toBe('unknown');
  });
});

describe('isAgentLabel', () => {
  it('is the rule of agent labels and connection names', () => {
    for (const ok of ['claude-code', 'tabula-cli', 'gemini_cli.2', 'x'.repeat(40)]) expect(isAgentLabel(ok), ok).toBe(true);
    for (const bad of ['', 'human', 'Claude', 'a b', 'x'.repeat(41), 'é']) expect(isAgentLabel(bad), bad).toBe(false);
  });
});

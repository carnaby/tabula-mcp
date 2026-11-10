import { describe, expect, it } from 'vitest';
import { COPY_PROMPT_MAX, copyPromptProblem, DEFAULT_COPY_PROMPT, fillCopyPrompt, normalizeCopyPrompt } from '../src/copy-prompt.js';

describe('copy prompt', () => {
  it('puts the reference wherever {ref} stands', () => {
    expect(fillCopyPrompt(DEFAULT_COPY_PROMPT, 'tabula:1a2b3c4d')).toBe('Process report tabula:1a2b3c4d.');
    expect(fillCopyPrompt('{ref}: read {ref} first', 'tabula:1a2b3c4d')).toBe('tabula:1a2b3c4d: read tabula:1a2b3c4d first');
  });

  it('adds the reference at the end after a space when the text has no {ref}', () => {
    expect(fillCopyPrompt('Spracuj hlásenie', 'tabula:1a2b3c4d')).toBe('Spracuj hlásenie tabula:1a2b3c4d');
  });

  it('trims the text and turns Windows line ends into new lines', () => {
    expect(normalizeCopyPrompt('  One\r\nTwo {ref}\n ')).toBe('One\nTwo {ref}');
  });

  it('allows 4 000 characters and no more', () => {
    expect(copyPromptProblem('x'.repeat(COPY_PROMPT_MAX))).toBeNull();
    expect(copyPromptProblem('😀'.repeat(COPY_PROMPT_MAX))).toBeNull();
    expect(copyPromptProblem('x'.repeat(COPY_PROMPT_MAX + 1))).toBe('text is 4001 characters; the limit is 4000');
  });

  it('refuses control characters other than a new line', () => {
    expect(copyPromptProblem('One\nTwo')).toBeNull();
    for (const code of [0, 9, 13, 27, 127, 0x80, 0x85, 0x9f]) {
      expect(copyPromptProblem(`a${String.fromCharCode(code)}b`)).toBe('text must not contain control characters other than a new line');
    }
  });
});

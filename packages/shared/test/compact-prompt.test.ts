import { describe, expect, it } from 'vitest';
import { COPY_PROMPT_MAX, copyPromptProblem } from '../src/copy-prompt.js';
import { DEFAULT_COMPACT_PROMPT, fillCompactPrompt } from '../src/compact-prompt.js';

describe('compact prompt', () => {
  it('leaves the text as it is without a tag', () => {
    expect(fillCompactPrompt('Tidy my thoughts.')).toBe('Tidy my thoughts.');
    expect(fillCompactPrompt('Tidy my thoughts.', '')).toBe('Tidy my thoughts.');
    expect(fillCompactPrompt(DEFAULT_COMPACT_PROMPT)).toBe(DEFAULT_COMPACT_PROMPT);
  });

  it('adds the tag scope as the last line', () => {
    expect(fillCompactPrompt('Tidy my thoughts.', 'nas')).toBe('Tidy my thoughts.\nOnly the thoughts tagged "nas".');
  });

  it('has a default that passes the shared checks and asks for a plan before any change', () => {
    expect(copyPromptProblem(DEFAULT_COMPACT_PROMPT)).toBeNull();
    expect([...DEFAULT_COMPACT_PROMPT].length).toBeLessThanOrEqual(COPY_PROMPT_MAX);
    expect(DEFAULT_COMPACT_PROMPT.startsWith('Tidy my Tabula notebook (Thoughts).')).toBe(true);
    expect(DEFAULT_COMPACT_PROMPT).toContain('Propose a plan and change nothing yet.');
    expect(DEFAULT_COMPACT_PROMPT).toContain('archived: true');
    expect(DEFAULT_COMPACT_PROMPT).toContain('Delete nothing.');
  });
});

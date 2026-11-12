import { describe, expect, it } from 'vitest';
import { COPY_PROMPT_MAX, copyPromptProblem } from '../src/copy-prompt.js';
import { DEFAULT_TIDY_PROMPT, fillTidyPrompt, PROJECT_PLACEHOLDER } from '../src/tidy-prompt.js';

describe('tidy prompt', () => {
  it('puts the project wherever {project} stands', () => {
    expect(fillTidyPrompt('Tidy {project}; recall {project} again.', 'demo')).toBe('Tidy demo; recall demo again.');
    const filled = fillTidyPrompt(DEFAULT_TIDY_PROMPT, 'demo');
    expect(filled).not.toContain(PROJECT_PLACEHOLDER);
    expect(filled.startsWith('Tidy the Tabula recall of project demo.')).toBe(true);
  });

  it('appends the project when the text has no {project}', () => {
    expect(fillTidyPrompt('Tidy the state files.', 'demo')).toBe('Tidy the state files.\nProject: demo');
  });

  it('has a default that passes the shared checks', () => {
    expect(copyPromptProblem(DEFAULT_TIDY_PROMPT)).toBeNull();
    expect([...DEFAULT_TIDY_PROMPT].length).toBeLessThanOrEqual(COPY_PROMPT_MAX);
    // Both markers the recall digest prints when a state file did not fit (digest.ts stateSection).
    expect(DEFAULT_TIDY_PROMPT).toContain('[… truncated');
    expect(DEFAULT_TIDY_PROMPT).toContain('[omitted to fit the budget');
    // Gotchas and rules are knowledge, not history: they stay where the next session reads them.
    expect(DEFAULT_TIDY_PROMPT).toContain('Lasting knowledge never goes to the archive.');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeMdSection, TABULA_JSON } from '../../src/mcp/snippet.js';

describe('claudeMdSection', () => {
  it('equals templates/claude-md-snippet.md', () => {
    const template = readFileSync(new URL('../../templates/claude-md-snippet.md', import.meta.url), 'utf8');
    expect(claudeMdSection('<slug>').trim()).toBe(template.trim());
  });

  it('suggests a .tabula.json that parses', () => {
    expect(JSON.parse(TABULA_JSON)).toEqual({ sync: ['docs/**', '.superpowers/sdd/*/progress.md'], state: ['docs/handoff/*.md'] });
  });

  it('the claude.ai template reads the state at start, notes on request and saves thoughts on request', () => {
    const t = readFileSync(new URL('../../templates/claude-ai-project-instructions.md', import.meta.url), 'utf8');
    for (const s of ['## Memory (Tabula)', '`recall`', '`list_files`', '`find_notes`', '`save_thought`', 'explicitly asks']) {
      expect(t).toContain(s);
    }
    expect(t).not.toContain('supersedes_id');
  });
});

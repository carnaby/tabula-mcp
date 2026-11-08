import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeMdSection, TABULA_JSON } from '../../src/mcp/snippet.js';

describe('claudeMdSection', () => {
  it('equals templates/claude-md-snippet.md', () => {
    const template = readFileSync(new URL('../../templates/claude-md-snippet.md', import.meta.url), 'utf8');
    expect(claudeMdSection('<slug>').trim()).toBe(template.trim());
  });

  it('keeps the local workflow and tells sessions without the tabula command to read and write over MCP', () => {
    const s = claudeMdSection('acme');
    expect(s).toContain('`include_state: false`');
    expect(s).toContain('`tabula push`');
    expect(s).toMatch(/`tabula` command is not available.*`include_state: true`.*`read_file`.*`write_file`/s);
    expect(s.split('\n').length).toBeLessThanOrEqual(9);
  });

  it('suggests a .tabula.json that parses', () => {
    expect(JSON.parse(TABULA_JSON)).toEqual({ sync: ['docs/**', '.superpowers/sdd/*/progress.md'], state: ['docs/handoff/*.md'] });
  });

  it('the claude.ai template reads the state at start and saves thoughts on request', () => {
    const t = readFileSync(new URL('../../templates/claude-ai-project-instructions.md', import.meta.url), 'utf8');
    for (const s of ['## Memory (Tabula)', '`recall`', '`list_files`', '`save_thought`', 'explicitly asks', '`write_file`', '`base_sha256`']) {
      expect(t).toContain(s);
    }
    // Notes are covered by the server instructions; the template does not repeat them.
    expect(t).not.toContain('`find_notes`');
    expect(t).not.toContain('supersedes_id');
  });

  it('the README shows the current CLAUDE.md section', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(claudeMdSection('my-project').trim());
  });
});

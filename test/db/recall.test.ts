import { describe, expect, it } from 'vitest';
import { deleteFile, putFile, setStatePaths } from '../../src/domain/files.js';
import { createMemory, deprecateMemory } from '../../src/domain/memories.js';
import { createNote } from '../../src/domain/notes.js';
import { recall } from '../../src/domain/recall.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const rule = (projectId: string, title: string) =>
  createMemory(db, { projectId, kind: 'rule', title, body: 'Because.', source: 'human' });
const file = (projectId: string, path: string, content: string) =>
  putFile(db, projectId, { path, content, baseSha256: null }, 'cli');

describe('recall', () => {
  it('has the global rules, the project state and the files — never project memories, notes or other projects', async () => {
    await seedProject(db, 'alpha');
    await seedProject(db, 'beta');
    await rule('global', 'Global rule');
    await rule('alpha', 'Alpha project memory');
    const old = await rule('global', 'Deprecated rule');
    await deprecateMemory(db, old.id, 'obsolete');
    await createNote(db, { title: 'Private note', body: 'secret plans', pinned: true });
    await file('alpha', 'docs/handoff/state.md', 'Next: ship it');
    await file('alpha', 'docs/plan.md', 'plan');
    await file('alpha', 'docs/gone.md', 'gone');
    await deleteFile(db, 'alpha', 'docs/gone.md');
    await file('beta', 'docs/beta.md', 'beta');
    await setStatePaths(db, 'alpha', ['docs/handoff/state.md']);

    const d = await recall(db, 'alpha', { now: new Date('2026-10-26T10:00:00Z') });
    expect(d.text).toContain('# Tabula · alpha · 2026-10-26');
    expect(d.text).toContain('- Global rule (#');
    expect(d.text).toMatch(/## Project state\n### docs\/handoff\/state\.md \(\d{4}-\d{2}-\d{2}\)\nNext: ship it/);
    expect(d.text).toContain('- docs/plan.md — ');
    for (const absent of ['Alpha project memory', 'Deprecated rule', 'Private note', 'secret plans', 'docs/beta.md', 'docs/gone.md']) {
      expect(d.text).not.toContain(absent);
    }

    const lean = await recall(db, 'alpha', { includeState: false });
    expect(lean.text).not.toContain('Next: ship it');
    expect(lean.text).toContain('- docs/handoff/state.md — ');
  });

  it('fails for an unknown project', async () => {
    await expect(recall(db, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

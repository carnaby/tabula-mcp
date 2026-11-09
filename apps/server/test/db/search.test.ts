import { beforeEach, describe, expect, it } from 'vitest';
import { deleteFile, putFile } from '../../src/domain/files.js';
import { createMemory, deprecateMemory } from '../../src/domain/memories.js';
import { createNote } from '../../src/domain/notes.js';
import { search } from '../../src/domain/search.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const mem = (projectId: string, title: string, body = 'Some context here.', kind: 'rule' | 'fact' = 'rule') =>
  createMemory(db, { projectId, kind, title, body, source: 'agent' });
const file = (projectId: string, path: string, content: string) =>
  putFile(db, projectId, { path, content, baseSha256: null }, 'cli');

describe('search', () => {
  beforeEach(async () => {
    await seedProject(db, 'alpha');
    await seedProject(db, 'beta');
  });

  it('finds global rules, never project memories or notes', async () => {
    await mem('global', 'Postgres runs on the primary host');
    await mem('alpha', 'Postgres alpha project memory');
    await createNote(db, { title: 'Postgres note' });
    const hits = await search(db, { query: 'postgres' });
    expect(hits).toMatchObject([{ type: 'memory', project: 'global', kind: 'rule', status: 'active' }]);
    expect(typeof hits[0]!.updated_at).toBe('string');
  });

  it('finds the files of the given project by path and content, or of every project without one', async () => {
    await file('alpha', 'docs/handoff/state.md', 'Next: drizzle migrations');
    await file('beta', 'docs/plan.md', 'drizzle upgrade plan');
    await mem('global', 'Drizzle over Prisma');
    expect((await search(db, { query: 'drizzle', project: 'alpha' })).map((h) => `${h.type}:${h.project}`).sort())
      .toEqual(['file:alpha', 'memory:global']);
    expect((await search(db, { query: 'drizzle' })).filter((h) => h.type === 'file').map((h) => h.project).sort())
      .toEqual(['alpha', 'beta']);
    expect((await search(db, { query: 'handoff', project: 'alpha' }))[0]).toMatchObject({
      type: 'file', path: 'docs/handoff/state.md', title: 'docs/handoff/state.md',
    });
    expect((await search(db, { query: 'migrations', project: 'alpha' }))[0]!.snippet).toContain('**migrations**');
  });

  it('hides deleted files, and all files when a kind is given', async () => {
    await file('alpha', 'docs/old.md', 'cache notes');
    await mem('global', 'Cache rule');
    await deleteFile(db, 'alpha', 'docs/old.md');
    expect((await search(db, { query: 'cache' })).map((h) => h.type)).toEqual(['memory']);
    await file('alpha', 'docs/new.md', 'cache notes');
    expect((await search(db, { query: 'cache', kind: 'rule' })).map((h) => h.type)).toEqual(['memory']);
  });

  it('hides deprecated rules unless asked', async () => {
    const m = await mem('global', 'Old vitest rule');
    await deprecateMemory(db, m.id, 'changed');
    expect(await search(db, { query: 'vitest' })).toEqual([]);
    expect((await search(db, { query: 'vitest', includeDeprecated: true }))[0]).toMatchObject({ status: 'deprecated' });
  });

  it('ranks title matches above body matches and highlights the snippet', async () => {
    await mem('global', 'Unrelated title', 'mentions migrations in body');
    await mem('global', 'Migrations run from CI', 'only from CI');
    const hits = await search(db, { query: 'migrations' });
    expect(hits[0]!.title).toBe('Migrations run from CI');
    expect(hits[1]!.snippet).toContain('**migrations**');
  });

  it('respects limit and validates input', async () => {
    for (let i = 0; i < 3; i++) await mem('global', `Cache rule ${i}`);
    expect(await search(db, { query: 'cache', limit: 2 })).toHaveLength(2);
    await expect(search(db, { query: '  ' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(search(db, { query: 'x', project: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

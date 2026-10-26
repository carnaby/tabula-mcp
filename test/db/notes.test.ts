import { describe, expect, it } from 'vitest';
import { createNote, deleteNote, findNotes, getNote, listNotes, noteTags, pageNotes, updateNote } from '../../src/domain/notes.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();

describe('notes', () => {
  it('creates with defaults and validates', async () => {
    await seedProject(db, 'demo');
    const n = await createNote(db, { projectId: 'demo', title: 'Architecture', tags: ['Arch'] });
    expect(n).toMatchObject({ summary: '', body: '', pinned: false, tags: ['arch'] });
    await expect(createNote(db, { projectId: 'demo', title: 't', summary: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(createNote(db, { projectId: 'nope', title: 't' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects NUL characters in body', async () => {
    await seedProject(db, 'demo');
    await expect(createNote(db, { projectId: 'demo', title: 't', body: 'a\u0000b' })).rejects.toMatchObject({ code: 'bad_request' });
    const n = await createNote(db, { projectId: 'demo', title: 't' });
    await expect(updateNote(db, n.id, { body: 'a\u0000b' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('updates, pins and lists pinned first', async () => {
    await seedProject(db, 'demo');
    const a = await createNote(db, { projectId: 'demo', title: 'A' });
    const b = await createNote(db, { projectId: 'demo', title: 'B' });
    await updateNote(db, a.id, { pinned: true, body: '# Protocol' });
    expect((await listNotes(db, { projectId: 'demo' })).map((n) => n.id)).toEqual([a.id, b.id]);
    expect((await getNote(db, a.id))?.body).toBe('# Protocol');
  });

  it('filters by fulltext and deletes', async () => {
    await seedProject(db, 'demo');
    const a = await createNote(db, { projectId: 'demo', title: 'Coding standards', body: 'naming rules' });
    await createNote(db, { projectId: 'demo', title: 'Other' });
    expect((await listNotes(db, { q: 'naming' })).map((n) => n.id)).toEqual([a.id]);
    await deleteNote(db, a.id);
    await expect(deleteNote(db, a.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('creates notebook notes without a project and filters them by tag', async () => {
    const a = await createNote(db, { title: 'Ambient ideas', tags: ['Music'], body: 'pads and drones' });
    expect(a.projectId).toBeNull();
    await createNote(db, { title: 'Other' });
    expect((await pageNotes(db, { tag: 'music' })).items.map((n) => n.id)).toEqual([a.id]);
    expect(await noteTags(db)).toEqual([{ tag: 'music', count: 1 }]);
  });

  it('finds notes newest first without a query and by prefix with one', async () => {
    const a = await createNote(db, { title: 'Ambient ideas', body: 'pads and drones' });
    const b = await createNote(db, { title: 'Postgres paging', body: 'keyset vs offset' });
    expect((await findNotes(db, {})).map((h) => h.id)).toEqual([b.id, a.id]);
    const hits = await findNotes(db, { query: 'keys' });
    expect(hits).toMatchObject([{ id: b.id, title: 'Postgres paging', project: null }]);
    expect(hits[0]!.snippet).toContain('**keyset**');
  });
});

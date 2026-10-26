import { describe, expect, it } from 'vitest';
import {
  createThought, findThoughts, HUMAN, KEEP_REVISIONS, listRevisions, pageThoughts, restoreRevision, updateThought,
} from '../../src/domain/thoughts.js';
import { useTestDb } from '../helpers.js';

const db = useTestDb();
const agent = { source: 'agent' as const, label: 'claude-ai' };

describe('thoughts', () => {
  it('validates title and body', async () => {
    await expect(createThought(db, { title: ' ' }, HUMAN)).rejects.toThrow(/title must not be empty/);
    await expect(createThought(db, { title: 'x'.repeat(201) }, HUMAN)).rejects.toThrow(/limit is 200/);
    await expect(createThought(db, { title: 't', body: 'x'.repeat(50_001) }, HUMAN)).rejects.toThrow(/Split it/);
  });

  it('keeps a revision only for content changes and caps the history', async () => {
    const t = await createThought(db, { title: 't', body: 'v1' }, HUMAN);
    const same = await updateThought(db, t.id, { body: 'v1', pinned: true }, agent);
    expect(same).toMatchObject({ version: 1, pinned: true, editedBy: 'human' });
    expect(same.updatedAt.getTime()).toBe(t.updatedAt.getTime());

    for (let i = 2; i <= KEEP_REVISIONS + 5; i++) await updateThought(db, t.id, { body: `v${i}` }, agent);
    const revs = await listRevisions(db, t.id);
    // The human's original v1 is never pruned, so it comes on top of the agent window.
    expect(revs.filter((r) => r.editedBy === 'claude-ai')).toHaveLength(KEEP_REVISIONS);
    expect(revs[0]).toMatchObject({ version: KEEP_REVISIONS + 4, body: `v${KEEP_REVISIONS + 4}`, editedBy: 'claude-ai' });
  });

  it('never prunes human revisions, however many agent edits follow', async () => {
    const t = await createThought(db, { title: 't', body: 'original human text' }, HUMAN);
    for (let i = 2; i <= KEEP_REVISIONS + 3; i++) await updateThought(db, t.id, { body: `v${i}` }, agent);
    const original = (await listRevisions(db, t.id)).find((r) => r.version === 1);
    expect(original).toMatchObject({ body: 'original human text', editedBy: 'human' });
    const restored = await restoreRevision(db, t.id, original!.id, HUMAN);
    expect(restored.body).toBe('original human text');
  });

  it('appends after a blank line, also to an empty body', async () => {
    const t = await createThought(db, { title: 't' }, HUMAN);
    expect((await updateThought(db, t.id, { append: ' one ' }, agent)).body).toBe('one');
    expect((await updateThought(db, t.id, { append: 'two' }, agent)).body).toBe('one\n\ntwo');
  });

  it('pages with pinned first and finds by prefix, tag and newest', async () => {
    const a = await createThought(db, { title: 'Ambient textures', tags: ['music'] }, HUMAN);
    const b = await createThought(db, { title: 'Postgres paging', body: 'keyset vs offset' }, agent);
    await updateThought(db, a.id, { pinned: true }, HUMAN);
    expect((await pageThoughts(db, {})).items.map((t) => t.id)).toEqual([a.id, b.id]);
    expect((await pageThoughts(db, { sort: 'title', dir: 'desc' })).items.map((t) => t.id)).toEqual([b.id, a.id]);
    expect((await pageThoughts(db, { source: 'agent' })).total).toBe(1);
    expect((await findThoughts(db, { query: 'keys' })).map((h) => h.id)).toEqual([b.id]);
    expect((await findThoughts(db, { tag: 'MUSIC' })).map((h) => h.id)).toEqual([a.id]);
    expect((await findThoughts(db, {})).map((h) => h.id)).toEqual([b.id, a.id]);
  });
});

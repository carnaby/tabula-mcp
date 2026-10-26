import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  createMemory, deleteMemory, deprecateMemory, getMemory, listMemories, supersedesChain, updateMemory,
} from '../../src/domain/memories.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const base = { projectId: 'demo', kind: 'rule' as const, title: 'Run tests via pnpm', body: 'Vitest directly skips setup.', source: 'agent' as const };

describe('memories', () => {
  it('creates with normalized tags and defaults', async () => {
    await seedProject(db, 'demo');
    const m = await createMemory(db, { ...base, tags: ['CI', 'ci'], agentLabel: 'claude-code' });
    expect(m).toMatchObject({ status: 'active', tags: ['ci'], source: 'agent', agentLabel: 'claude-code', supersedesId: null });
  });

  it('rejects unknown project and invalid text', async () => {
    await expect(createMemory(db, base)).rejects.toMatchObject({ code: 'not_found' });
    await seedProject(db, 'demo');
    await expect(createMemory(db, { ...base, body: '' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('supersede deprecates the old record in the same call', async () => {
    await seedProject(db, 'demo');
    const old = await createMemory(db, base);
    const neu = await createMemory(db, { ...base, title: 'Run tests via pnpm test:unit', supersedesId: old.id });
    const after = await getMemory(db, old.id);
    expect(after).toMatchObject({ status: 'deprecated', deprecatedReason: `superseded by ${neu.id}` });
    expect(neu.supersedesId).toBe(old.id);
  });

  it('supersede of a missing or deprecated record fails and writes nothing', async () => {
    await seedProject(db, 'demo');
    await expect(createMemory(db, { ...base, supersedesId: '00000000-0000-4000-8000-000000000000' }))
      .rejects.toMatchObject({ code: 'not_found' });
    const old = await createMemory(db, base);
    await deprecateMemory(db, old.id, 'obsolete');
    await expect(createMemory(db, { ...base, supersedesId: old.id })).rejects.toMatchObject({ code: 'conflict' });
    expect(await listMemories(db, { projectId: 'demo', status: 'all' })).toHaveLength(1);
  });

  it('deprecate is idempotent and requires a reason', async () => {
    await seedProject(db, 'demo');
    const m = await createMemory(db, base);
    await expect(deprecateMemory(db, m.id, ' ')).rejects.toMatchObject({ code: 'bad_request' });
    expect(await deprecateMemory(db, m.id, 'changed')).toEqual({ changed: true });
    expect(await deprecateMemory(db, m.id, 'again')).toEqual({ changed: false });
    expect((await getMemory(db, m.id))?.deprecatedReason).toBe('changed');
  });

  it('updates fields with validation and bumps updatedAt', async () => {
    await seedProject(db, 'demo');
    const created = await createMemory(db, base);
    // Backdate in the DB so the comparison involves DB timestamps only (no Node clock, no sleeps).
    await db.execute(sql`UPDATE memories SET updated_at = now() - interval '1 hour' WHERE id = ${created.id}`);
    const m = (await getMemory(db, created.id))!;
    const u = await updateMemory(db, m.id, { title: 'New title', tags: ['X'] });
    expect(u).toMatchObject({ title: 'New title', tags: ['x'], body: base.body });
    expect(u.updatedAt.getTime()).toBeGreaterThan(m.updatedAt.getTime());
    await expect(updateMemory(db, m.id, { title: 'x'.repeat(121) })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('lists with filters, newest first, active by default, with fulltext', async () => {
    await seedProject(db, 'demo');
    const a = await createMemory(db, { ...base, title: 'Alpha rule' });
    const b = await createMemory(db, { ...base, kind: 'fact', title: 'Beta fact' });
    await deprecateMemory(db, a.id, 'x');
    expect((await listMemories(db, {})).map((m) => m.id)).toEqual([b.id]);
    expect((await listMemories(db, { status: 'all' })).map((m) => m.id)).toEqual([b.id, a.id]);
    expect((await listMemories(db, { status: 'all', kind: 'rule' })).map((m) => m.id)).toEqual([a.id]);
    expect((await listMemories(db, { status: 'all', q: 'beta' })).map((m) => m.id)).toEqual([b.id]);
  });

  it('returns the supersedes chain oldest to newest', async () => {
    await seedProject(db, 'demo');
    const v1 = await createMemory(db, base);
    const v2 = await createMemory(db, { ...base, supersedesId: v1.id });
    const v3 = await createMemory(db, { ...base, supersedesId: v2.id });
    expect((await supersedesChain(db, v2.id)).map((m) => m.id)).toEqual([v1.id, v2.id, v3.id]);
  });

  it('hard delete detaches successors', async () => {
    await seedProject(db, 'demo');
    const v1 = await createMemory(db, base);
    const v2 = await createMemory(db, { ...base, supersedesId: v1.id });
    await deleteMemory(db, v1.id);
    expect((await getMemory(db, v2.id))?.supersedesId).toBeNull();
    await expect(deleteMemory(db, v1.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

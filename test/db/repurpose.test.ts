import { describe, expect, it } from 'vitest';
import { createMemory, getMemory } from '../../src/domain/memories.js';
import { createNote, getNote } from '../../src/domain/notes.js';
import { applyRepurpose, formatPlan, GLOBAL_REASON, planRepurpose, PROJECT_REASON } from '../../src/maintenance/repurpose.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const mem = (projectId: string, title: string) => createMemory(db, { projectId, kind: 'fact', title, body: 'b', source: 'agent' });

describe('repurpose cleanup', () => {
  it('lists candidates without changing anything, applies only what was chosen, and is idempotent', async () => {
    await seedProject(db, 'mc');
    await seedProject(db, 'mc-station');
    const p1 = await mem('mc', 'Project memory one');
    const p2 = await mem('mc-station', 'Project memory two');
    const keep = await mem('global', 'Keep this global rule');
    const domain = await mem('global', 'A project-specific trick');
    const note = await createNote(db, { projectId: 'global', title: 'Chat protocol', body: 'x' });
    await createNote(db, { title: 'Already in the notebook' });

    const dry = await planRepurpose(db, []);
    expect(dry.projectMemories.map((c) => c.id).sort()).toEqual([p1.id, p2.id].sort());
    expect(dry.projectNotes.map((c) => c.id)).toEqual([note.id]);
    expect(dry.globalMemories.map((c) => c.id).sort()).toEqual([keep.id, domain.id].sort());
    expect(dry.globalToArchive).toEqual([]);
    expect(formatPlan(dry)).toContain('Project memory one');
    expect((await getMemory(db, p1.id))?.status).toBe('active');

    const bogus = await planRepurpose(db, ['00000000-0000-4000-8000-000000000000']);
    await expect(applyRepurpose(db, bogus)).rejects.toThrow(/unknown or inactive/);
    expect((await getMemory(db, p1.id))?.status).toBe('active');

    const wrong = await planRepurpose(db, [p1.id, p1.id.slice(0, 8)]);
    expect(wrong.unknownIds).toEqual([p1.id, p1.id.slice(0, 8)]);
    expect(wrong.globalToArchive).toEqual([]);
    await expect(applyRepurpose(db, wrong)).rejects.toThrow(/unknown or inactive/);
    expect((await getMemory(db, p1.id))?.status).toBe('active');
    expect((await getNote(db, note.id))?.projectId).toBe('global');

    const plan = await planRepurpose(db, [domain.id.toUpperCase()]);
    expect(plan.globalToArchive.map((c) => c.id)).toEqual([domain.id]);
    expect(await applyRepurpose(db, plan)).toEqual({ archived: 3, movedNotes: 1 });
    expect(await getMemory(db, p1.id)).toMatchObject({ status: 'deprecated', deprecatedReason: PROJECT_REASON });
    expect(await getMemory(db, domain.id)).toMatchObject({ status: 'deprecated', deprecatedReason: GLOBAL_REASON });
    expect((await getMemory(db, keep.id))?.status).toBe('active');
    expect((await getNote(db, note.id))?.projectId).toBeNull();

    expect(await applyRepurpose(db, await planRepurpose(db, []))).toEqual({ archived: 0, movedNotes: 0 });
    expect((await planRepurpose(db, [domain.id])).unknownIds).toEqual([domain.id]);
  });
});

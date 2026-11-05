import { describe, expect, it } from 'vitest';
import { memories, notes, projectFiles, projects, reportAttachments, reports } from '../../src/db/schema.js';
import { createProject, listProjects, requireProject, updateProject } from '../../src/domain/projects.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();

describe('projects', () => {
  it('lists global first with active memory counts and live file counts', async () => {
    await seedProject(db, 'alpha');
    await db.insert(memories).values([
      { projectId: 'global', kind: 'rule', title: 'a', body: 'b', source: 'human' },
      { projectId: 'global', kind: 'rule', title: 'c', body: 'd', source: 'human', status: 'deprecated' },
    ]);
    const file = { projectId: 'alpha', content: 'x', sha256: 'h', size: 1, updatedBy: 'cli' };
    await db.insert(projectFiles).values([
      { ...file, path: 'a.md' },
      { ...file, path: 'b.md', deletedAt: new Date() },
    ]);
    expect(await listProjects(db)).toEqual([
      { id: 'global', name: 'Global', description: 'Rules and notes that apply to every project.', memory_count: 1, file_count: 0, last_activity_at: expect.any(String) },
      { id: 'alpha', name: 'alpha', description: 'alpha project', memory_count: 0, file_count: 1, last_activity_at: expect.any(String) },
    ]);
  });

  it('orders projects by their latest activity, global first, equal ones by slug', async () => {
    const day = (d: number) => new Date(Date.UTC(2026, 10, d));
    await db.insert(projects).values(
      ['a-file', 'b-deleted', 'c-report', 'd-attachment', 'e-note', 'f-idle', 'g-idle'].map((id) => ({ id, name: id, createdAt: day(1) })),
    );
    const file = { content: 'x', sha256: 'h', size: 1, updatedBy: 'cli' };
    await db.insert(projectFiles).values([
      { ...file, projectId: 'a-file', path: 'a.md', updatedAt: day(3) },
      { ...file, projectId: 'b-deleted', path: 'b.md', updatedAt: day(2), deletedAt: day(6) },
    ]);
    const report = { title: 'r', source: 'human' as const, editedBy: 'human' };
    await db.insert(reports).values({ ...report, projectId: 'c-report', updatedAt: day(4) });
    const [old] = await db.insert(reports).values({ ...report, projectId: 'd-attachment', updatedAt: day(2) }).returning();
    await db.insert(reportAttachments).values({
      reportId: old!.id, kind: 'image', mime: 'image/png', size: 1, sha256: 'x', fileName: 'p.png', storageKey: `${old!.id}/p.png`,
      createdBy: 'human', createdAt: day(5),
    });
    await db.insert(notes).values({ projectId: 'e-note', title: 'n', updatedAt: day(7) });

    const list = await listProjects(db);
    expect(list.map((p) => p.id)).toEqual(['global', 'e-note', 'b-deleted', 'd-attachment', 'c-report', 'a-file', 'f-idle', 'g-idle']);
    expect(list.find((p) => p.id === 'b-deleted')!.last_activity_at).toBe(day(6).toISOString());
    expect(list.find((p) => p.id === 'f-idle')!.last_activity_at).toBe(day(1).toISOString());
  });

  it('requireProject lists known projects on miss', async () => {
    await seedProject(db, 'alpha');
    await expect(requireProject(db, 'nope')).rejects.toThrow(/project "nope" does not exist\. Known projects: global, alpha/);
  });

  it('creates and updates a project, rejecting duplicates', async () => {
    await createProject(db, { id: 'demo', name: 'Demo' });
    await expect(createProject(db, { id: 'demo', name: 'X' })).rejects.toMatchObject({ code: 'conflict' });
    const p = await updateProject(db, 'demo', { description: 'Gate' });
    expect(p.description).toBe('Gate');
  });
});

import { describe, expect, it } from 'vitest';
import { memories, projectFiles } from '../../src/db/schema.js';
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
      { id: 'global', name: 'Global', description: 'Rules and notes that apply to every project.', memory_count: 1, file_count: 0 },
      { id: 'alpha', name: 'alpha', description: 'alpha project', memory_count: 0, file_count: 1 },
    ]);
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

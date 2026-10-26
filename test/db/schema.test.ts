import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { memories, notes, projectFileRevisions, projectFiles, projects } from '../../src/db/schema.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();

describe('schema', () => {
  it('has the global project seeded', async () => {
    const rows = await db.select().from(projects);
    expect(rows.map((r) => r.id)).toEqual(['global']);
  });

  it('refuses to delete the global project', async () => {
    // drizzle-orm wraps driver errors in DrizzleQueryError; the Postgres message lives on `.cause`.
    await expect(db.execute(sql`DELETE FROM projects WHERE id = 'global'`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/cannot be deleted/) },
    });
  });

  it('builds a weighted simple-config search vector', async () => {
    await seedProject(db, 'demo');
    await db.insert(memories).values({
      projectId: 'demo', kind: 'decision', title: 'Drizzle over Prisma',
      body: 'Migrácie sú v repe.', tags: ['orm'], source: 'human',
    });
    const [row] = await db.execute<{ search: string }>(sql`SELECT search::text AS search FROM memories`);
    expect(row!.search).toContain("'drizzle':1A");
    expect(row!.search).toMatch(/'orm':\d+B/);
    expect(row!.search).toContain("'migrácie'"); // simple config: no stemming, diacritics are kept
  });

  it('enforces the title length limit', async () => {
    await seedProject(db, 'demo');
    await expect(
      db.insert(memories).values({ projectId: 'demo', kind: 'fact', title: 'x'.repeat(121), body: 'b', source: 'human' }),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/memories_title_len/) } });
  });

  it('allows notes without a project (the notebook)', async () => {
    await db.insert(notes).values({ title: 'Loose note' });
    const [row] = await db.select().from(notes);
    expect(row!.projectId).toBeNull();
  });

  it('keeps one file per project and path, with a path-aware search vector', async () => {
    await seedProject(db, 'demo');
    const row = {
      projectId: 'demo', path: 'docs/handoff/state.md', content: 'Migrácie bežia z CI.', sha256: 'x', size: 1, updatedBy: 'cli',
    };
    await db.insert(projectFiles).values(row);
    await expect(db.insert(projectFiles).values(row)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/project_files_project_path_idx/) },
    });
    const [v] = await db.execute<{ search: string }>(sql`SELECT search::text AS search FROM project_files`);
    expect(v!.search).toMatch(/'handoff':\d+A/);
    expect(v!.search).toMatch(/'md':\d+A/);
    expect(v!.search).toMatch(/'migrácie':\d+C/);
  });

  it('deletes revisions together with their file', async () => {
    await seedProject(db, 'demo');
    const [f] = await db.insert(projectFiles)
      .values({ projectId: 'demo', path: 'a.md', content: 'b', sha256: 'y', size: 1, updatedBy: 'cli' })
      .returning();
    await db.insert(projectFileRevisions).values({
      fileId: f!.id, version: 1, content: 'a', sha256: 'z', size: 1, updatedBy: 'cli', createdAt: new Date(),
    });
    await db.delete(projectFiles);
    expect(await db.select().from(projectFileRevisions)).toEqual([]);
  });
});

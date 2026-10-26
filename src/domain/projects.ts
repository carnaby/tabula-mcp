import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { conflict, notFound } from './errors.js';
import { validateProjectSlug } from './validation.js';

export type Project = typeof projects.$inferSelect;
export type ProjectSummary = { id: string; name: string; description: string; memory_count: number; file_count: number };

export async function listProjects(db: Db): Promise<ProjectSummary[]> {
  const rows = await db.execute<ProjectSummary>(sql`
    SELECT p.id, p.name, p.description,
      (SELECT count(*)::int FROM memories m WHERE m.project_id = p.id AND m.status = 'active') AS memory_count,
      (SELECT count(*)::int FROM project_files f WHERE f.project_id = p.id AND f.deleted_at IS NULL) AS file_count
    FROM projects p
    ORDER BY (p.id = 'global') DESC, p.id`);
  return [...rows];
}

export async function requireProject(db: Db, id: string): Promise<Project> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  if (row) return row;
  const known = (await listProjects(db)).map((p) => p.id).join(', ');
  throw notFound(
    `project "${id}" does not exist. Known projects: ${known}. Projects are created by the human in the Tabula UI.`,
  );
}

export async function createProject(db: Db, input: { id: string; name: string; description?: string }): Promise<Project> {
  const id = validateProjectSlug(input.id);
  const [row] = await db
    .insert(projects)
    .values({ id, name: input.name.trim() || id, description: input.description?.trim() ?? '' })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict(`project "${id}" already exists`);
  return row;
}

export async function updateProject(db: Db, id: string, patch: { name?: string; description?: string }): Promise<Project> {
  await requireProject(db, id);
  const [row] = await db
    .update(projects)
    .set({
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.description !== undefined && { description: patch.description.trim() }),
    })
    .where(eq(projects.id, id))
    .returning();
  return row!;
}

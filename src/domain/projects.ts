import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { conflict, notFound } from './errors.js';
import { validateProjectSlug } from './validation.js';

export type Project = typeof projects.$inferSelect;
export type ProjectSummary = {
  id: string; name: string; description: string; memory_count: number; file_count: number;
  /** The latest change in the project (ISO): created, a file written or deleted, a report changed or given a file, a note changed. */
  last_activity_at: string;
};

type ProjectRow = Omit<ProjectSummary, 'last_activity_at'> & { last_activity_at: Date | string };

/** Global first, then the most recently active projects (the sidebar's order); equal ones by slug. */
export async function listProjects(db: Db): Promise<ProjectSummary[]> {
  // Restoring a soft-deleted file keeps its updated_at and clears deleted_at, so a restore does not count as activity.
  const rows = await db.execute<ProjectRow>(sql`
    SELECT p.id, p.name, p.description,
      (SELECT count(*)::int FROM memories m WHERE m.project_id = p.id AND m.status = 'active') AS memory_count,
      (SELECT count(*)::int FROM project_files f WHERE f.project_id = p.id AND f.deleted_at IS NULL) AS file_count,
      GREATEST(
        p.created_at,
        (SELECT max(GREATEST(f.updated_at, f.deleted_at)) FROM project_files f WHERE f.project_id = p.id),
        (SELECT max(r.updated_at) FROM reports r WHERE r.project_id = p.id),
        (SELECT max(a.created_at) FROM report_attachments a JOIN reports r ON r.id = a.report_id WHERE r.project_id = p.id),
        (SELECT max(n.updated_at) FROM notes n WHERE n.project_id = p.id)
      ) AS last_activity_at
    FROM projects p
    ORDER BY (p.id = 'global') DESC, last_activity_at DESC, p.id`);
  return [...rows].map((r) => ({ ...r, last_activity_at: new Date(r.last_activity_at).toISOString() }));
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

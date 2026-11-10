import { and, asc, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memories, projectFiles } from '../db/schema.js';
import { buildDigest, type Digest } from './digest.js';
import { requireProject } from './projects.js';

/** The active global memories: every digest starts with them. */
const globalMemories = (db: Db) =>
  db
    .select({ id: memories.id, kind: memories.kind, title: memories.title, body: memories.body, updatedAt: memories.updatedAt })
    .from(memories)
    .where(and(eq(memories.projectId, 'global'), eq(memories.status, 'active')));

/** The metadata of the files matching a condition (the file list of a digest). */
const fileMetadata = (db: Db, where: SQL | undefined) =>
  db
    .select({ projectId: projectFiles.projectId, path: projectFiles.path, size: projectFiles.size, updatedAt: projectFiles.updatedAt, isState: projectFiles.isState })
    .from(projectFiles)
    .where(where);

/** The state files matching a condition, newest first (the state of a digest). */
const stateFiles = (db: Db, where: SQL | undefined) =>
  db
    .select({ projectId: projectFiles.projectId, path: projectFiles.path, content: projectFiles.content, updatedAt: projectFiles.updatedAt })
    .from(projectFiles)
    .where(and(where, eq(projectFiles.isState, true)))
    .orderBy(desc(projectFiles.updatedAt), asc(projectFiles.path));

/** The digest an agent reads at session start: global rules, the project state (optional) and the file list. */
export async function recall(
  db: Db,
  projectId: string,
  opts: { includeState?: boolean; now?: Date } = {},
): Promise<Digest> {
  await requireProject(db, projectId);
  const alive = and(eq(projectFiles.projectId, projectId), isNull(projectFiles.deletedAt));
  const [rules, files, state] = await Promise.all([
    globalMemories(db),
    fileMetadata(db, alive),
    opts.includeState === false ? Promise.resolve([]) : stateFiles(db, alive),
  ]);
  return buildDigest({
    project: projectId, date: (opts.now ?? new Date()).toISOString().slice(0, 10), memories: rules, files, state,
  });
}

/** Rows by their project, in their order. */
function byProject<T extends { projectId: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.projectId);
    if (list) list.push(row);
    else map.set(row.projectId, [row]);
  }
  return map;
}

/**
 * The digests of several projects with their state (what the Recall preview shows), from three queries whatever the
 * number of projects: the Home page's recall meter and its "Recall trimmed" warnings. Same builder and inputs as recall().
 */
export async function recallDigests(db: Db, projectIds: readonly string[], now = new Date()): Promise<Map<string, Digest>> {
  const ids = [...projectIds];
  if (!ids.length) return new Map();
  const alive = and(inArray(projectFiles.projectId, ids), isNull(projectFiles.deletedAt));
  const [rules, files, state] = await Promise.all([globalMemories(db), fileMetadata(db, alive), stateFiles(db, alive)]);
  const filesOf = byProject(files);
  const stateOf = byProject(state);
  const date = now.toISOString().slice(0, 10);
  return new Map(
    ids.map((id) => [id, buildDigest({ project: id, date, memories: rules, files: filesOf.get(id) ?? [], state: stateOf.get(id) ?? [] })]),
  );
}

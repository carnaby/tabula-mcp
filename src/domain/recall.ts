import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memories, projectFiles } from '../db/schema.js';
import { buildDigest, type Digest } from './digest.js';
import { requireProject } from './projects.js';

/** The digest an agent reads at session start: global rules, the project state (optional) and the file list. */
export async function recall(
  db: Db,
  projectId: string,
  opts: { includeState?: boolean; now?: Date } = {},
): Promise<Digest> {
  await requireProject(db, projectId);
  const alive = and(eq(projectFiles.projectId, projectId), isNull(projectFiles.deletedAt));
  const [rules, files, state] = await Promise.all([
    db
      .select({ id: memories.id, kind: memories.kind, title: memories.title, body: memories.body, updatedAt: memories.updatedAt })
      .from(memories)
      .where(and(eq(memories.projectId, 'global'), eq(memories.status, 'active'))),
    db
      .select({ path: projectFiles.path, size: projectFiles.size, updatedAt: projectFiles.updatedAt, isState: projectFiles.isState })
      .from(projectFiles)
      .where(alive),
    opts.includeState === false
      ? Promise.resolve([])
      : db
          .select({ path: projectFiles.path, content: projectFiles.content, updatedAt: projectFiles.updatedAt })
          .from(projectFiles)
          .where(and(alive, eq(projectFiles.isState, true)))
          .orderBy(desc(projectFiles.updatedAt), asc(projectFiles.path)),
  ]);
  return buildDigest({
    project: projectId, date: (opts.now ?? new Date()).toISOString().slice(0, 10), memories: rules, files, state,
  });
}

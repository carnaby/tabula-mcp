import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projectSyncConfigs } from '../db/schema.js';
import { badRequest, conflict, notFound } from './errors.js';
import { deleteFile, getFile, listFiles, putFile, validateFilePath } from './files.js';
import { matchesSyncPattern } from './glob.js';
import { requireProject } from './projects.js';
import { charCount } from './validation.js';

export const SYNC_CONFIG_LIMITS = { patterns: 100, patternChars: 512 } as const;

export type SyncConfig = { sync: string[]; state: string[]; updatedAt: Date };
export type SyncedWrite = { path: string; sha256: string; version: number; changed: boolean; state: boolean };

const CONTROL = /[\x00-\x1f\x7f]/;
const NO_FILES_IN_GLOBAL = 'project "global" holds the global rules and has no files; use the project named in the "Memory (Tabula)" section';

function validatePatterns(key: 'sync' | 'state', list: readonly string[]): string[] {
  if (!Array.isArray(list)) throw badRequest(`"${key}" must be a list of glob patterns`);
  if (list.length > SYNC_CONFIG_LIMITS.patterns) {
    throw badRequest(`"${key}" has ${list.length} patterns; the limit is ${SYNC_CONFIG_LIMITS.patterns}`);
  }
  for (const p of list) {
    if (typeof p !== 'string' || p.length === 0) throw badRequest(`"${key}" patterns must be non-empty strings`);
    if (charCount(p) > SYNC_CONFIG_LIMITS.patternChars) {
      throw badRequest(`a "${key}" pattern is longer than ${SYNC_CONFIG_LIMITS.patternChars} characters`);
    }
    if (CONTROL.test(p)) throw badRequest(`"${key}" patterns must not contain control characters`);
  }
  return [...list];
}

async function requireFileProject(db: Db, projectId: string): Promise<void> {
  if (projectId === 'global') throw badRequest(NO_FILES_IN_GLOBAL);
  await requireProject(db, projectId);
}

/** Stored on every `tabula push`, so the server knows which paths agents without the CLI may write. */
export async function setSyncConfig(db: Db, projectId: string, input: { sync: string[]; state: string[] }): Promise<SyncConfig> {
  const sync = validatePatterns('sync', input.sync);
  if (sync.length === 0) throw badRequest('"sync" needs at least one glob pattern');
  const state = validatePatterns('state', input.state);
  await requireFileProject(db, projectId);
  const [row] = await db
    .insert(projectSyncConfigs)
    .values({ projectId, sync, state })
    .onConflictDoUpdate({ target: projectSyncConfigs.projectId, set: { sync, state, updatedAt: new Date() } })
    .returning();
  return { sync: row!.sync, state: row!.state, updatedAt: row!.updatedAt };
}

export async function getSyncConfig(db: Db, projectId: string): Promise<SyncConfig | null> {
  await requireProject(db, projectId);
  const [row] = await db.select().from(projectSyncConfigs).where(eq(projectSyncConfigs.projectId, projectId));
  return row ? { sync: row.sync, state: row.state, updatedAt: row.updatedAt } : null;
}

/** The project's patterns, and the path checked against them: the rules every agent write goes through. */
async function requireWritablePath(db: Db, projectId: string, rawPath: string): Promise<{ path: string; config: SyncConfig }> {
  await requireFileProject(db, projectId);
  const path = validateFilePath(rawPath);
  const config = await getSyncConfig(db, projectId);
  if (!config) {
    throw badRequest(
      `Tabula does not know yet which files project "${projectId}" syncs: run \`tabula push\` once on a computer with the repository (it sends the patterns of .tabula.json), then retry`,
    );
  }
  if (!matchesSyncPattern(path, config.sync)) {
    throw badRequest(`"${path}" is not a synced file of project "${projectId}"; agents may write only paths matching its sync patterns: ${config.sync.join(', ')}`);
  }
  return { path, config };
}

/**
 * The spelling already in the project when `path` or one of its folders differs from it only in letter case: on
 * Windows and macOS that is one file or folder, and the tabula command syncs neither of the two.
 */
export function caseTwin(existing: readonly string[], path: string): string | null {
  const segs = path.split('/');
  for (const other of existing) {
    if (other === path) continue;
    const o = other.split('/');
    for (let i = 0; i < Math.min(segs.length, o.length); i++) {
      if (segs[i] === o[i]) continue;
      if (segs[i]!.toLowerCase() !== o[i]!.toLowerCase()) break;
      const folderInBoth = i < segs.length - 1 && i < o.length - 1;
      const fileInBoth = i === segs.length - 1 && i === o.length - 1;
      if (folderInBoth || fileInBoth) return o.slice(0, i + 1).join('/');
      break;
    }
  }
  return null;
}

/**
 * An agent's write: only synced paths, never blind. A new (or deleted) file needs no base; an existing one needs the
 * sha256 of the version the agent read, and there is no force.
 */
export async function writeSyncedFile(
  db: Db, projectId: string, input: { path: string; content: string; baseSha256: string | null }, updatedBy: string,
): Promise<SyncedWrite> {
  const { path, config } = await requireWritablePath(db, projectId, input.path);
  const twin = caseTwin((await listFiles(db, projectId)).map((f) => f.path), path);
  if (twin) {
    throw badRequest(
      `"${path}" differs only in letter case from "${twin}", already in project "${projectId}"; on Windows and macOS they are the same, so the tabula command would sync neither. Use the spelling "${twin}"`,
    );
  }
  if (input.baseSha256 === null) {
    const existing = await getFile(db, projectId, path).catch(() => null);
    if (existing && existing.deletedAt === null) {
      throw conflict(`"${path}" already exists (version ${existing.version}); read it with read_file and pass the sha256 from its header as base_sha256`);
    }
  }
  const state = matchesSyncPattern(path, config.state);
  const r = await putFile(db, projectId, { path, content: input.content, baseSha256: input.baseSha256, isState: state }, updatedBy);
  if (!r.ok) {
    const now = await getFile(db, projectId, path);
    throw conflict(
      `"${path}" changed since the version you read: the current version is ${now.version} with sha256 ${now.sha256}; read it again with read_file, apply your change to that text and retry with its sha256 as base_sha256`,
    );
  }
  return { path, sha256: r.sha256, version: r.version, changed: r.changed, state };
}

/** An agent's delete: soft (restorable in the UI), only of the version the agent read. */
export async function deleteSyncedFile(
  db: Db, projectId: string, input: { path: string; baseSha256: string },
): Promise<{ path: string; deleted: true }> {
  const { path } = await requireWritablePath(db, projectId, input.path);
  const gone = () => notFound(`"${path}" is not a file of project "${projectId}" (or was deleted already); call list_files for the current files`);
  const f = await getFile(db, projectId, path);
  if (f.deletedAt) throw gone();
  const { changed } = await deleteFile(db, projectId, path, { baseSha256: input.baseSha256 });
  if (!changed) throw gone();
  return { path, deleted: true };
}

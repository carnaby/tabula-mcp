import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projectFileRevisions, projectFiles } from '../db/schema.js';
import { badRequest, notFound, tooLarge } from './errors.js';
import { requireProject } from './projects.js';
import { charCount } from './validation.js';

export const FILE_LIMITS = { pathChars: 512, contentBytes: 1_048_576 } as const;
/** Previous versions kept per file; older ones are deleted in the same transaction. */
export const KEEP_FILE_REVISIONS = 20;

const BLOCKED_SEGMENTS = new Set(['', '.', '..', '.git', 'node_modules']);
const CONTROL = /[\x00-\x1f\x7f]/;

export const isEnvFileName = (name: string): boolean => name === '.env' || name.startsWith('.env.');

export function validateFilePath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) throw badRequest('path must not be empty');
  const n = charCount(raw);
  if (n > FILE_LIMITS.pathChars) throw badRequest(`path is ${n} characters; the limit is ${FILE_LIMITS.pathChars}`);
  if (CONTROL.test(raw)) throw badRequest('path must not contain control characters');
  if (raw.includes('\\')) throw badRequest('path must use forward slashes (a POSIX path relative to the repository root)');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw badRequest('path must be relative to the repository root');
  const segments = raw.split('/');
  // Case-insensitive and ignoring trailing dots/spaces: on Windows and macOS these resolve into the real directory.
  if (segments.some((s) => BLOCKED_SEGMENTS.has(s.toLowerCase().replace(/[. ]+$/, '')))) {
    throw badRequest('path must not contain empty, ".", "..", ".git" or "node_modules" segments');
  }
  if (isEnvFileName(segments[segments.length - 1]!)) throw badRequest('.env files are never stored in Tabula');
  return raw;
}

export function validateFileContent(content: string): { sha256: string; size: number } {
  if (content.includes(String.fromCharCode(0))) {
    throw badRequest('content must not contain NUL characters; binary files are not synced');
  }
  const bytes = Buffer.from(content, 'utf8');
  // Lone surrogates do not survive a UTF-8 round trip: Postgres would store U+FFFD and the hash would lie.
  if (bytes.toString('utf8') !== content) throw badRequest('content must be valid UTF-8 text');
  if (bytes.length > FILE_LIMITS.contentBytes) {
    throw tooLarge(`content is ${bytes.length} bytes; the limit is ${FILE_LIMITS.contentBytes} (1 MiB)`);
  }
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

export type FileMeta = {
  path: string;
  sha256: string;
  size: number;
  version: number;
  isState: boolean;
  updatedBy: string;
  updatedAt: Date;
  deletedAt: Date | null;
};
export type ProjectFile = FileMeta & { id: string; projectId: string; content: string; createdAt: Date };
export type FileRevisionMeta = { version: number; sha256: string; size: number; updatedBy: string; createdAt: Date };
export type FileRevision = FileRevisionMeta & { content: string };
export type PutFileInput = { path: string; content: string; baseSha256: string | null; force?: boolean };
export type PutFileResult =
  | { ok: true; sha256: string; version: number; changed: boolean }
  | { ok: false; sha256: string };

const meta = {
  path: projectFiles.path,
  sha256: projectFiles.sha256,
  size: projectFiles.size,
  version: projectFiles.version,
  isState: projectFiles.isState,
  updatedBy: projectFiles.updatedBy,
  updatedAt: projectFiles.updatedAt,
  deletedAt: projectFiles.deletedAt,
};
const full = { ...meta, id: projectFiles.id, projectId: projectFiles.projectId, content: projectFiles.content, createdAt: projectFiles.createdAt };
const revisionMeta = {
  version: projectFileRevisions.version,
  sha256: projectFileRevisions.sha256,
  size: projectFileRevisions.size,
  updatedBy: projectFileRevisions.updatedBy,
  createdAt: projectFileRevisions.createdAt,
};
/** Setting updated_at to itself stops Drizzle's $onUpdate: deleting, restoring and state marking are not edits. */
const keepUpdatedAt = { updatedAt: sql`${projectFiles.updatedAt}` };
const at = (projectId: string, path: string) => and(eq(projectFiles.projectId, projectId), eq(projectFiles.path, path));

/**
 * Optimistic locking: the write is accepted only if baseSha256 is the server's current hash, or the file does not
 * exist (a soft-deleted file counts as not existing), or force is set. Identical content is always a no-op.
 */
export async function putFile(db: Db, projectId: string, input: PutFileInput, updatedBy: string): Promise<PutFileResult> {
  await requireProject(db, projectId);
  const path = validateFilePath(input.path);
  const { sha256, size } = validateFileContent(input.content);
  return db.transaction(async (tx) => {
    const lock = async () => (await tx.select(full).from(projectFiles).where(at(projectId, path)).for('update'))[0];
    let cur = await lock();
    if (!cur) {
      const [created] = await tx
        .insert(projectFiles)
        .values({ projectId, path, content: input.content, sha256, size, updatedBy })
        .onConflictDoNothing({ target: [projectFiles.projectId, projectFiles.path] })
        .returning({ version: projectFiles.version });
      if (created) return { ok: true, sha256, version: created.version, changed: true };
      // Another writer created the same path meanwhile: continue as an update of its row.
      cur = await lock();
      if (!cur) throw new Error(`project file ${projectId}:${path} vanished during insert`);
    }
    const alive = cur.deletedAt === null;
    if (cur.sha256 === sha256) {
      if (!alive) await tx.update(projectFiles).set({ deletedAt: null, ...keepUpdatedAt }).where(eq(projectFiles.id, cur.id));
      return { ok: true, sha256, version: cur.version, changed: !alive };
    }
    if (alive && !input.force && input.baseSha256 !== cur.sha256) return { ok: false, sha256: cur.sha256 };

    const version = cur.version + 1;
    await tx.insert(projectFileRevisions).values({
      fileId: cur.id, version: cur.version, content: cur.content, sha256: cur.sha256, size: cur.size,
      updatedBy: cur.updatedBy, createdAt: cur.updatedAt,
    });
    await tx
      .delete(projectFileRevisions)
      .where(and(eq(projectFileRevisions.fileId, cur.id), lte(projectFileRevisions.version, version - 1 - KEEP_FILE_REVISIONS)));
    await tx
      .update(projectFiles)
      .set({ content: input.content, sha256, size, version, updatedBy, deletedAt: null })
      .where(eq(projectFiles.id, cur.id));
    return { ok: true, sha256, version, changed: true };
  });
}

export async function listFiles(db: Db, projectId: string, opts: { includeDeleted?: boolean } = {}): Promise<FileMeta[]> {
  await requireProject(db, projectId);
  return db
    .select(meta)
    .from(projectFiles)
    .where(and(eq(projectFiles.projectId, projectId), opts.includeDeleted ? undefined : isNull(projectFiles.deletedAt)))
    .orderBy(asc(projectFiles.path));
}

/** Also returns soft-deleted files (deletedAt is set); callers decide whether that counts. */
export async function getFile(db: Db, projectId: string, rawPath: string): Promise<ProjectFile> {
  await requireProject(db, projectId);
  const path = validateFilePath(rawPath);
  const [row] = await db.select(full).from(projectFiles).where(at(projectId, path));
  if (!row) throw notFound(`file "${path}" does not exist in project "${projectId}"; call list_files for the paths`);
  return row;
}

export async function deleteFile(db: Db, projectId: string, path: string): Promise<{ changed: boolean }> {
  const f = await getFile(db, projectId, path);
  const rows = await db
    .update(projectFiles)
    .set({ deletedAt: sql`now()`, ...keepUpdatedAt })
    .where(and(eq(projectFiles.id, f.id), isNull(projectFiles.deletedAt)))
    .returning({ id: projectFiles.id });
  return { changed: rows.length > 0 };
}

export async function restoreFile(db: Db, projectId: string, path: string): Promise<{ changed: boolean }> {
  const f = await getFile(db, projectId, path);
  const rows = await db
    .update(projectFiles)
    .set({ deletedAt: null, ...keepUpdatedAt })
    .where(and(eq(projectFiles.id, f.id), isNotNull(projectFiles.deletedAt)))
    .returning({ id: projectFiles.id });
  return { changed: rows.length > 0 };
}

export async function listFileRevisions(db: Db, projectId: string, path: string): Promise<FileRevisionMeta[]> {
  const f = await getFile(db, projectId, path);
  return db
    .select(revisionMeta)
    .from(projectFileRevisions)
    .where(eq(projectFileRevisions.fileId, f.id))
    .orderBy(desc(projectFileRevisions.version));
}

export async function getFileRevision(db: Db, projectId: string, path: string, version: number): Promise<FileRevision> {
  const f = await getFile(db, projectId, path);
  const [row] = await db
    .select({ ...revisionMeta, content: projectFileRevisions.content })
    .from(projectFileRevisions)
    .where(and(eq(projectFileRevisions.fileId, f.id), eq(projectFileRevisions.version, version)));
  if (!row) throw notFound(`version ${version} of "${f.path}" is not kept (only the last ${KEEP_FILE_REVISIONS} previous versions are)`);
  return row;
}

/** The CLI sends the paths that match the "state" patterns of .tabula.json; every other file of the project is unmarked. */
export async function setStatePaths(db: Db, projectId: string, paths: string[]): Promise<{ updated: number }> {
  await requireProject(db, projectId);
  const inProject = eq(projectFiles.projectId, projectId);
  return db.transaction(async (tx) => {
    const on = paths.length
      ? await tx
          .update(projectFiles)
          .set({ isState: true, ...keepUpdatedAt })
          .where(and(inProject, eq(projectFiles.isState, false), inArray(projectFiles.path, paths)))
          .returning({ id: projectFiles.id })
      : [];
    const off = await tx
      .update(projectFiles)
      .set({ isState: false, ...keepUpdatedAt })
      .where(and(inProject, eq(projectFiles.isState, true), paths.length ? notInArray(projectFiles.path, paths) : undefined))
      .returning({ id: projectFiles.id });
    return { updated: on.length + off.length };
  });
}

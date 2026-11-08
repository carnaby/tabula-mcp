import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { REF_PREFIX, refOf } from '../shared/refs.js';
import { DomainError, notFound } from './errors.js';
import { getFileById, type ProjectFile } from './files.js';
import { parseIdRef, shortIds } from './ids.js';
import { getMemory, type Memory } from './memories.js';
import { getNote, type Note } from './notes.js';
import { type Attachment, getAttachment, getReport, type Report } from './reports.js';
import { getThought, type Thought } from './thoughts.js';

export type RecordType = 'memory' | 'note' | 'thought' | 'report' | 'file' | 'attachment';

export type ResolvedRecord =
  | { type: 'memory'; record: Memory }
  | { type: 'note'; record: Note }
  | { type: 'thought'; record: Thought }
  | { type: 'report'; record: Report }
  | { type: 'file'; record: ProjectFile }
  | { type: 'attachment'; record: Attachment; report: Report };

/** One of the records a short reference matches; `ref` is long enough to tell it from the others. */
export type RefCandidate = { type: RecordType; id: string; ref: string; title: string };

/** A short reference that matches more than one record (400); the UI lists the candidates. */
export class AmbiguousRefError extends DomainError {
  constructor(message: string, readonly candidates: RefCandidate[]) {
    super('bad_request', message);
  }
}

/** What the UI needs to open the record a reference points at (GET /api/resolve/:ref). */
export type RefTarget = {
  ref: string;
  type: RecordType;
  id: string;
  project: string | null;
  title: string;
  kind?: string;
  report_id?: string;
  path?: string;
  status?: string;
};

async function byId(db: Db, id: string): Promise<ResolvedRecord | undefined> {
  const m = await getMemory(db, id);
  if (m) return { type: 'memory', record: m };
  const n = await getNote(db, id);
  if (n) return { type: 'note', record: n };
  const t = await getThought(db, id);
  if (t) return { type: 'thought', record: t };
  const r = await getReport(db, id);
  if (r) return { type: 'report', record: r };
  const f = await getFileById(db, id);
  if (f) return { type: 'file', record: f };
  const a = await getAttachment(db, id);
  if (!a) return undefined;
  const report = await getReport(db, a.reportId);
  return report ? { type: 'attachment', record: a, report } : undefined;
}

/** Records whose id starts with the hex prefix (dashes ignored), at most 6 per type (lowest ids first, so the shortest unique prefix does not depend on row order). */
async function candidatesOf(db: Db, prefix: string, legacy: boolean): Promise<{ id: string; type: RecordType; title: string }[]> {
  const match = sql`replace(id::text, '-', '') LIKE ${`${prefix}%`}`;
  const filesAndAttachments = legacy
    ? sql``
    : sql`
      UNION ALL (SELECT id::text, 'file', project_id || ': ' || path FROM project_files WHERE ${match} ORDER BY id LIMIT 6)
      UNION ALL (SELECT id::text, 'attachment', file_name FROM report_attachments WHERE ${match} ORDER BY id LIMIT 6)`;
  const rows = await db.execute<{ id: string; type: RecordType; title: string }>(sql`
    (SELECT id::text AS id, 'memory' AS type, title FROM memories WHERE ${match} ORDER BY id LIMIT 6)
    UNION ALL (SELECT id::text, 'note', title FROM notes WHERE ${match} ORDER BY id LIMIT 6)
    UNION ALL (SELECT id::text, 'thought', title FROM thoughts WHERE ${match} ORDER BY id LIMIT 6)
    UNION ALL (SELECT id::text, 'report', title FROM reports WHERE ${match} ORDER BY id LIMIT 6)
    ${filesAndAttachments}`);
  return [...rows];
}

/**
 * The record a reference points at: `tabula:` + 4–32 hex, a full uuid, or the old `#xxxx` (see IdRef for its
 * narrower scope). Inactive records are found as well; their state is in the record.
 */
export async function resolveRecord(db: Db, raw: string): Promise<ResolvedRecord> {
  const ref = parseIdRef(raw);
  if (ref.kind === 'full') {
    const found = await byId(db, ref.id);
    if (!found) throw notFound(`no record has id ${ref.id}`);
    return found;
  }
  const shown = ref.legacy ? `#${ref.prefix}` : `${REF_PREFIX}${ref.prefix}`;
  const list = await candidatesOf(db, ref.prefix, ref.legacy);
  if (list.length === 0) {
    const hint = ref.legacy ? `; files and attachments are found with ${REF_PREFIX}${ref.prefix}` : '';
    throw notFound(`no record matches ${shown}${hint}`);
  }
  if (list.length > 1) {
    const hexOf = (id: string) => id.replace(/-/g, '');
    const short = shortIds(list.map((c) => hexOf(c.id)), 8);
    const candidates = list.map((c) => ({ type: c.type, id: c.id, ref: `${REF_PREFIX}${short.get(hexOf(c.id))!}`, title: c.title }));
    const names = candidates.map((c) => `${c.ref} (${c.type}: ${c.title})`).join('; ');
    throw new AmbiguousRefError(`${shown} is ambiguous; it matches ${names}. Pass more characters.`, candidates);
  }
  const found = await byId(db, list[0]!.id);
  if (!found) throw notFound(`no record matches ${shown}`);
  return found;
}

export function refTarget(r: ResolvedRecord): RefTarget {
  const base = { ref: refOf(r.record.id), type: r.type, id: r.record.id };
  switch (r.type) {
    case 'memory':
      return { ...base, project: r.record.projectId, title: r.record.title, kind: r.record.kind, status: r.record.status };
    case 'note':
      return { ...base, project: r.record.projectId, title: r.record.title };
    case 'thought':
      return { ...base, project: null, title: r.record.title, status: r.record.archived ? 'archived' : 'active' };
    case 'report':
      return { ...base, project: r.record.projectId, title: r.record.title, status: r.record.status };
    case 'file':
      return { ...base, project: r.record.projectId, title: r.record.path, path: r.record.path, status: r.record.deletedAt ? 'deleted' : 'active' };
    case 'attachment':
      return {
        ...base, project: r.report.projectId, title: r.record.fileName, kind: r.record.kind, report_id: r.record.reportId,
        status: r.record.purgedAt ? 'purged' : 'active',
      };
  }
}

import { type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { badRequest } from './errors.js';
import { requireProject } from './projects.js';
import { prefixTsQuery } from './paging.js';
import type { MemoryKind } from './validation.js';

export type SearchHit = {
  id: string;
  type: 'memory' | 'note';
  project: string;
  kind?: MemoryKind;
  title: string;
  snippet: string;
  status: 'active' | 'deprecated';
  updated_at: string;
};

export type SearchParams = {
  query: string;
  project?: string;
  kind?: MemoryKind;
  includeDeprecated?: boolean;
  limit?: number;
};

const HEADLINE = 'MaxWords=30, MinWords=10, MaxFragments=1, StartSel=**, StopSel=**';

type Row = {
  id: string;
  type: 'memory' | 'note';
  project: string;
  kind: MemoryKind | null;
  title: string;
  snippet: string;
  status: 'active' | 'deprecated';
  updated_at: Date | string;
};

export async function search(db: Db, p: SearchParams): Promise<SearchHit[]> {
  const query = p.query.trim();
  if (!query) throw badRequest('query must not be empty');
  if (p.project) await requireProject(db, p.project);
  const limit = Math.min(Math.max(Math.trunc(p.limit ?? 10), 1), 50);

  const memProject = p.project ? sql`AND m.project_id IN (${p.project}, 'global')` : sql``;
  const noteProject = p.project ? sql`AND n.project_id IN (${p.project}, 'global')` : sql``;
  const kind = p.kind ? sql`AND m.kind = ${p.kind}` : sql``;
  const status = p.includeDeprecated ? sql`` : sql`AND m.status = 'active'`;

  const memoryPart = sql`
    SELECT m.id, 'memory' AS type, m.project_id AS project, m.kind::text AS kind, m.title,
      ts_headline('simple', m.body, q.tsq, ${HEADLINE}) AS snippet,
      m.status::text AS status, m.updated_at, ts_rank(m.search, q.tsq) AS rank
    FROM memories m, q
    WHERE m.search @@ q.tsq ${memProject} ${kind} ${status}`;

  const notePart = sql`
    SELECT n.id, 'note' AS type, n.project_id AS project, NULL AS kind, n.title,
      ts_headline('simple', n.summary || ' ' || n.body, q.tsq, ${HEADLINE}) AS snippet,
      'active' AS status, n.updated_at, ts_rank(n.search, q.tsq) AS rank
    FROM notes n, q
    WHERE n.search @@ q.tsq ${noteProject}`;

  const parts: SQL = p.kind ? memoryPart : sql`${memoryPart} UNION ALL ${notePart}`;

  const rows = await db.execute<Row>(sql`
    WITH q AS (SELECT websearch_to_tsquery('simple', ${query}) AS tsq)
    SELECT id, type, project, kind, title, snippet, status, updated_at
    FROM (${parts}) hits
    ORDER BY rank DESC, updated_at DESC
    LIMIT ${limit}`);

  return [...rows].map((r) => ({
    id: r.id,
    type: r.type,
    project: r.project,
    ...(r.kind ? { kind: r.kind } : {}),
    title: r.title,
    snippet: r.snippet,
    status: r.status,
    updated_at: new Date(r.updated_at).toISOString(),
  }));
}

export type QuickHit = {
  id: string;
  type: 'memory' | 'note' | 'thought' | 'file';
  project: string | null;
  kind: MemoryKind | null;
  title: string;
  snippet: string;
  status: 'active' | 'deprecated';
  updated_at: string;
};

/** The UI's global search box: prefix match over memories, notes, thoughts and project files, best match first. */
export async function quickSearch(db: Db, p: { q: string; limit?: number }): Promise<QuickHit[]> {
  const tsq = prefixTsQuery(p.q);
  if (!tsq) return [];
  const limit = Math.min(Math.max(Math.trunc(p.limit ?? 20), 1), 50);
  const rows = await db.execute<Omit<QuickHit, 'updated_at'> & { updated_at: Date | string }>(sql`
    WITH q AS (SELECT to_tsquery('simple', ${tsq}) AS tsq)
    SELECT id, type, project, kind, title,
      ts_headline('simple', doc, (SELECT tsq FROM q), ${HEADLINE}) AS snippet, status, updated_at
    FROM (
      -- Rank and limit first; the expensive headline runs only for the rows that survive.
      SELECT id, type, project, kind, title, doc, status, updated_at, rank FROM (
        SELECT m.id, 'memory' AS type, m.project_id AS project, m.kind::text AS kind, m.title,
          m.body AS doc, m.status::text AS status, m.updated_at, ts_rank(m.search, q.tsq) AS rank
        FROM memories m, q WHERE m.search @@ q.tsq
        UNION ALL
        SELECT n.id, 'note', n.project_id, NULL, n.title,
          n.summary || ' ' || n.body, 'active', n.updated_at, ts_rank(n.search, q.tsq)
        FROM notes n, q WHERE n.search @@ q.tsq
        UNION ALL
        SELECT t.id, 'thought', NULL, NULL, t.title,
          t.body, 'active', t.updated_at, ts_rank(t.search, q.tsq)
        FROM thoughts t, q WHERE t.search @@ q.tsq AND NOT t.archived
        UNION ALL
        SELECT f.id, 'file', f.project_id, NULL, f.path,
          left(f.content, 100000), 'active', f.updated_at, ts_rank(f.search, q.tsq)
        FROM project_files f, q WHERE f.search @@ q.tsq AND f.deleted_at IS NULL
      ) hits
      ORDER BY (status = 'active') DESC, rank DESC, updated_at DESC
      LIMIT ${limit}
    ) top
    ORDER BY (status = 'active') DESC, rank DESC, updated_at DESC`);
  return [...rows].map((r) => ({ ...r, updated_at: new Date(r.updated_at).toISOString() }));
}

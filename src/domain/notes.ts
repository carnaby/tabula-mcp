import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { notes } from '../db/schema.js';
import { notFound } from './errors.js';
import { matchesPrefix, type Page, type PageQuery, pageWindow, prefixTsQuery } from './paging.js';
import { requireProject } from './projects.js';
import { normalizeTags, rejectNul, validateNoteText } from './validation.js';

const cols = {
  id: notes.id,
  projectId: notes.projectId,
  title: notes.title,
  summary: notes.summary,
  body: notes.body,
  tags: notes.tags,
  pinned: notes.pinned,
  createdAt: notes.createdAt,
  updatedAt: notes.updatedAt,
};

export type Note = {
  id: string;
  projectId: string | null;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export async function getNote(db: Db, id: string): Promise<Note | undefined> {
  const [row] = await db.select(cols).from(notes).where(eq(notes.id, id));
  return row;
}

export async function createNote(
  db: Db,
  input: { projectId?: string | null; title: string; summary?: string; body?: string; tags?: string[]; pinned?: boolean },
): Promise<Note> {
  if (input.projectId) await requireProject(db, input.projectId);
  const text = validateNoteText({ title: input.title, summary: input.summary ?? '' });
  const body = input.body ?? '';
  rejectNul(body, 'body');
  const [row] = await db
    .insert(notes)
    .values({
      projectId: input.projectId ?? null,
      ...text,
      body,
      tags: normalizeTags(input.tags),
      pinned: input.pinned ?? false,
    })
    .returning(cols);
  return row!;
}

export async function updateNote(
  db: Db,
  id: string,
  patch: { title?: string; summary?: string; body?: string; tags?: string[]; pinned?: boolean },
): Promise<Note> {
  const current = await getNote(db, id);
  if (!current) throw notFound(`note ${id} does not exist`);
  const text = validateNoteText({ title: patch.title ?? current.title, summary: patch.summary ?? current.summary });
  if (patch.body !== undefined) rejectNul(patch.body, 'body');
  const [row] = await db
    .update(notes)
    .set({
      ...text,
      ...(patch.body !== undefined && { body: patch.body }),
      ...(patch.tags !== undefined && { tags: normalizeTags(patch.tags) }),
      ...(patch.pinned !== undefined && { pinned: patch.pinned }),
    })
    .where(eq(notes.id, id))
    .returning(cols);
  return row!;
}

export async function deleteNote(db: Db, id: string): Promise<void> {
  const deleted = await db.delete(notes).where(eq(notes.id, id)).returning({ id: notes.id });
  if (deleted.length === 0) throw notFound(`note ${id} does not exist`);
}

export async function listNotes(db: Db, f: { projectId?: string; q?: string }): Promise<Note[]> {
  const q = f.q?.trim();
  return db
    .select(cols)
    .from(notes)
    .where(
      and(
        f.projectId ? eq(notes.projectId, f.projectId) : undefined,
        q ? sql`${notes.search} @@ websearch_to_tsquery('simple', ${q})` : undefined,
      ),
    )
    .orderBy(desc(notes.pinned), desc(notes.updatedAt));
}

export const NOTE_SORTS = ['updatedAt', 'createdAt', 'title', 'pinned'] as const;
export type NoteSort = (typeof NOTE_SORTS)[number];

/** The UI table. Pinned notes stay on top unless another order is asked for. */
export async function pageNotes(
  db: Db,
  f: { projectId?: string; q?: string; tag?: string } & PageQuery<NoteSort>,
): Promise<Page<Note>> {
  const { page, pageSize, limit, offset } = pageWindow(f);
  const tsq = prefixTsQuery(f.q);
  const where = and(
    f.projectId ? eq(notes.projectId, f.projectId) : undefined,
    tsq ? matchesPrefix(notes.search, tsq) : undefined,
    f.tag ? sql`${f.tag.trim().toLowerCase()} = ANY(${notes.tags})` : undefined,
  );
  const order = (f.dir ?? 'desc') === 'asc' ? asc : desc;
  const primary = f.sort ? [order(notes[f.sort])] : [desc(notes.pinned), desc(notes.updatedAt)];
  const [items, [total]] = await Promise.all([
    db.select(cols).from(notes).where(where).orderBy(...primary, desc(notes.updatedAt), asc(notes.id)).limit(limit).offset(offset),
    db.select({ n: count() }).from(notes).where(where),
  ]);
  return { items, total: total?.n ?? 0, page, pageSize };
}

export async function noteTags(db: Db): Promise<{ tag: string; count: number }[]> {
  const rows = await db.execute<{ tag: string; count: number }>(sql`
    SELECT t AS tag, count(*)::int AS count
    FROM notes, unnest(tags) AS t
    GROUP BY t
    ORDER BY count DESC, t`);
  return [...rows];
}

export type NoteHit = { id: string; title: string; tags: string[]; snippet: string; project: string | null; updated_at: string };

/** For agents, only when the user mentions their notes: newest first without a query, best match first with one. */
export async function findNotes(db: Db, p: { query?: string; tag?: string; limit?: number }): Promise<NoteHit[]> {
  const limit = Math.min(Math.max(Math.trunc(p.limit ?? 10), 1), 50);
  const tsq = prefixTsQuery(p.query);
  const snippet = tsq
    ? sql<string>`ts_headline('simple', ${notes.summary} || ' ' || ${notes.body}, to_tsquery('simple', ${tsq}), 'MaxWords=30, MinWords=10, MaxFragments=1, StartSel=**, StopSel=**')`
    : sql<string>`left(${notes.body}, 200)`;
  const rows = await db
    .select({ id: notes.id, title: notes.title, tags: notes.tags, snippet, projectId: notes.projectId, updatedAt: notes.updatedAt })
    .from(notes)
    .where(
      and(
        tsq ? matchesPrefix(notes.search, tsq) : undefined,
        p.tag ? sql`${p.tag.trim().toLowerCase()} = ANY(${notes.tags})` : undefined,
      ),
    )
    .orderBy(...(tsq ? [desc(sql`ts_rank(${notes.search}, to_tsquery('simple', ${tsq}))`)] : []), desc(notes.updatedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id, title: r.title, tags: r.tags, snippet: r.snippet, project: r.projectId, updated_at: r.updatedAt.toISOString(),
  }));
}

import { and, asc, count, desc, eq, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { thoughtRevisions, thoughts } from '../db/schema.js';
import { conflict, notFound } from './errors.js';
import { matchesPrefix, type Page, type PageQuery, pageWindow, prefixTsQuery } from './paging.js';
import { normalizeTags, validateThoughtText } from './validation.js';

/** Older revisions beyond this many are dropped. */
export const KEEP_REVISIONS = 50;

const cols = {
  id: thoughts.id,
  title: thoughts.title,
  body: thoughts.body,
  tags: thoughts.tags,
  pinned: thoughts.pinned,
  archived: thoughts.archived,
  source: thoughts.source,
  editedBy: thoughts.editedBy,
  version: thoughts.version,
  createdAt: thoughts.createdAt,
  updatedAt: thoughts.updatedAt,
};

export type Thought = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  source: 'agent' | 'human';
  editedBy: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ThoughtRevision = {
  id: string;
  thoughtId: string;
  version: number;
  title: string;
  body: string;
  tags: string[];
  editedBy: string;
  createdAt: Date;
};

/** Who is writing: the human in the UI, or an agent with its label. */
export type Editor = { source: 'agent' | 'human'; label: string };
export const HUMAN: Editor = { source: 'human', label: 'human' };

export async function getThought(db: Db, id: string): Promise<Thought | undefined> {
  const [row] = await db.select(cols).from(thoughts).where(eq(thoughts.id, id));
  return row;
}

export async function createThought(
  db: Db,
  input: { title: string; body?: string; tags?: string[]; pinned?: boolean },
  editor: Editor,
): Promise<Thought> {
  const text = validateThoughtText({ title: input.title, body: input.body ?? '' });
  const [row] = await db
    .insert(thoughts)
    .values({
      ...text,
      tags: normalizeTags(input.tags),
      pinned: input.pinned ?? false,
      source: editor.source,
      editedBy: editor.label,
    })
    .returning(cols);
  return row!;
}

export type ThoughtPatch = {
  title?: string;
  body?: string;
  /** Appended to the body after a blank line (agents adding to an existing thought). */
  append?: string;
  tags?: string[];
  pinned?: boolean;
  archived?: boolean;
  /** Reject the write if someone else changed the thought since this version was read. */
  expectedVersion?: number;
};

/**
 * Content changes (title, body, tags) bump the version and keep the previous one as a revision;
 * pinning and archiving do not.
 */
export async function updateThought(db: Db, id: string, patch: ThoughtPatch, editor: Editor): Promise<Thought> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select(cols).from(thoughts).where(eq(thoughts.id, id)).for('update');
    if (!cur) throw notFound(`thought ${id} does not exist`);
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== cur.version) {
      throw conflict(
        `thought was changed meanwhile by ${cur.editedBy} (now version ${cur.version}, you edited ${patch.expectedVersion}). Reload it and apply your change again.`,
      );
    }

    let body = patch.body ?? cur.body;
    if (patch.append?.trim()) body = body.trim() ? `${body.trimEnd()}\n\n${patch.append.trim()}` : patch.append.trim();
    const text = validateThoughtText({ title: patch.title ?? cur.title, body });
    const tags = patch.tags !== undefined ? normalizeTags(patch.tags) : cur.tags;
    const contentChanged = text.title !== cur.title || text.body !== cur.body || tags.join('\u0001') !== cur.tags.join('\u0001');

    if (contentChanged) {
      await tx.insert(thoughtRevisions).values({
        thoughtId: cur.id, version: cur.version, title: cur.title, body: cur.body, tags: cur.tags,
        editedBy: cur.editedBy, createdAt: cur.updatedAt,
      });
      await tx
        .delete(thoughtRevisions)
        .where(and(eq(thoughtRevisions.thoughtId, cur.id), lte(thoughtRevisions.version, cur.version - KEEP_REVISIONS)));
    }

    const [row] = await tx
      .update(thoughts)
      .set({
        ...(contentChanged && { ...text, tags, editedBy: editor.label, version: cur.version + 1 }),
        ...(patch.pinned !== undefined && { pinned: patch.pinned }),
        ...(patch.archived !== undefined && { archived: patch.archived }),
        ...(!contentChanged && { updatedAt: cur.updatedAt }),
      })
      .where(eq(thoughts.id, id))
      .returning(cols);
    return row!;
  });
}

export async function deleteThought(db: Db, id: string): Promise<void> {
  const deleted = await db.delete(thoughts).where(eq(thoughts.id, id)).returning({ id: thoughts.id });
  if (deleted.length === 0) throw notFound(`thought ${id} does not exist`);
}

export async function listRevisions(db: Db, id: string): Promise<ThoughtRevision[]> {
  if (!(await getThought(db, id))) throw notFound(`thought ${id} does not exist`);
  return db.select().from(thoughtRevisions).where(eq(thoughtRevisions.thoughtId, id)).orderBy(desc(thoughtRevisions.version));
}

/** Restoring is itself an edit: the current text becomes a revision, so a restore can be undone too. */
export async function restoreRevision(db: Db, id: string, revisionId: string, editor: Editor): Promise<Thought> {
  const [rev] = await db
    .select()
    .from(thoughtRevisions)
    .where(and(eq(thoughtRevisions.id, revisionId), eq(thoughtRevisions.thoughtId, id)));
  if (!rev) throw notFound(`revision ${revisionId} of thought ${id} does not exist`);
  return updateThought(db, id, { title: rev.title, body: rev.body, tags: rev.tags }, editor);
}

export const THOUGHT_SORTS = ['updatedAt', 'createdAt', 'title'] as const;
export type ThoughtSort = (typeof THOUGHT_SORTS)[number];

export type ThoughtFilter = { q?: string; tag?: string; archived?: boolean | 'all'; source?: 'agent' | 'human' };

function thoughtWhere(f: ThoughtFilter) {
  const tsq = prefixTsQuery(f.q);
  const archived = f.archived ?? false;
  return and(
    archived !== 'all' ? eq(thoughts.archived, archived) : undefined,
    f.tag ? sql`${f.tag.trim().toLowerCase()} = ANY(${thoughts.tags})` : undefined,
    f.source ? eq(thoughts.source, f.source) : undefined,
    tsq ? matchesPrefix(thoughts.search, tsq) : undefined,
  );
}

export async function pageThoughts(db: Db, f: ThoughtFilter & PageQuery<ThoughtSort>): Promise<Page<Thought>> {
  const { page, pageSize, limit, offset } = pageWindow(f);
  const where = thoughtWhere(f);
  const order = (f.dir ?? 'desc') === 'asc' ? asc : desc;
  const primary = f.sort ? [order(thoughts[f.sort])] : [desc(thoughts.pinned), desc(thoughts.updatedAt)];
  const [items, [total]] = await Promise.all([
    db.select(cols).from(thoughts).where(where).orderBy(...primary, asc(thoughts.id)).limit(limit).offset(offset),
    db.select({ n: count() }).from(thoughts).where(where),
  ]);
  return { items, total: total?.n ?? 0, page, pageSize };
}

export async function thoughtTags(db: Db): Promise<{ tag: string; count: number }[]> {
  const rows = await db.execute<{ tag: string; count: number }>(sql`
    SELECT t AS tag, count(*)::int AS count
    FROM thoughts, unnest(tags) AS t
    WHERE NOT archived
    GROUP BY t
    ORDER BY count DESC, t`);
  return [...rows];
}

export type ThoughtHit = {
  id: string; title: string; tags: string[]; snippet: string; version: number; edited_by: string; updated_at: string;
};

/** For agents: newest first without a query, best match first with one. */
export async function findThoughts(db: Db, p: { query?: string; tag?: string; limit?: number }): Promise<ThoughtHit[]> {
  const limit = Math.min(Math.max(Math.trunc(p.limit ?? 10), 1), 50);
  const tsq = prefixTsQuery(p.query);
  const where = thoughtWhere({ q: p.query, tag: p.tag });
  const snippet = tsq
    ? sql<string>`ts_headline('simple', ${thoughts.body}, to_tsquery('simple', ${tsq}), 'MaxWords=30, MinWords=10, MaxFragments=1, StartSel=**, StopSel=**')`
    : sql<string>`left(${thoughts.body}, 200)`;
  const rows = await db
    .select({
      id: thoughts.id, title: thoughts.title, tags: thoughts.tags, snippet, version: thoughts.version,
      editedBy: thoughts.editedBy, updatedAt: thoughts.updatedAt,
    })
    .from(thoughts)
    .where(where)
    .orderBy(
      ...(tsq ? [desc(sql`ts_rank(${thoughts.search}, to_tsquery('simple', ${tsq}))`)] : []),
      desc(thoughts.updatedAt),
    )
    .limit(limit);
  return rows.map((r) => ({
    id: r.id, title: r.title, tags: r.tags, snippet: r.snippet, version: r.version, edited_by: r.editedBy, updated_at: r.updatedAt.toISOString(),
  }));
}

import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memories } from '../db/schema.js';
import { badRequest, conflict, notFound } from './errors.js';
import { matchesPrefix, type Page, type PageQuery, pageWindow, prefixTsQuery } from './paging.js';
import { requireProject } from './projects.js';
import { type MemoryKind, normalizeTags, validateMemoryText } from './validation.js';

const cols = {
  id: memories.id,
  projectId: memories.projectId,
  kind: memories.kind,
  title: memories.title,
  body: memories.body,
  tags: memories.tags,
  status: memories.status,
  supersedesId: memories.supersedesId,
  deprecatedReason: memories.deprecatedReason,
  source: memories.source,
  agentLabel: memories.agentLabel,
  createdAt: memories.createdAt,
  updatedAt: memories.updatedAt,
};

export type Memory = {
  id: string;
  projectId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  tags: string[];
  status: 'active' | 'deprecated';
  supersedesId: string | null;
  deprecatedReason: string | null;
  source: 'agent' | 'human';
  agentLabel: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NewMemory = {
  projectId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  tags?: string[];
  supersedesId?: string | null;
  source: 'agent' | 'human';
  agentLabel?: string | null;
};

export async function getMemory(db: Db, id: string): Promise<Memory | undefined> {
  const [row] = await db.select(cols).from(memories).where(eq(memories.id, id));
  return row;
}

async function requireMemory(db: Db, id: string): Promise<Memory> {
  const m = await getMemory(db, id);
  if (!m) throw notFound(`memory ${id} does not exist`);
  return m;
}

export async function createMemory(db: Db, input: NewMemory): Promise<Memory> {
  await requireProject(db, input.projectId);
  const text = validateMemoryText(input);
  return db.transaction(async (tx) => {
    if (input.supersedesId) {
      const [old] = await tx.select(cols).from(memories).where(eq(memories.id, input.supersedesId)).for('update');
      if (!old) throw notFound(`memory ${input.supersedesId} (supersedes_id) does not exist`);
      if (old.status === 'deprecated') {
        throw conflict(`memory ${old.id} is already deprecated; search for the record that replaced it`);
      }
    }
    const [created] = await tx
      .insert(memories)
      .values({
        projectId: input.projectId,
        kind: input.kind,
        title: text.title,
        body: text.body,
        tags: normalizeTags(input.tags),
        supersedesId: input.supersedesId ?? null,
        source: input.source,
        agentLabel: input.agentLabel ?? null,
      })
      .returning(cols);
    if (input.supersedesId) {
      await tx
        .update(memories)
        .set({ status: 'deprecated', deprecatedReason: `superseded by ${created!.id}` })
        .where(eq(memories.id, input.supersedesId));
    }
    return created!;
  });
}

export async function updateMemory(
  db: Db,
  id: string,
  patch: { title?: string; body?: string; tags?: string[]; kind?: MemoryKind },
): Promise<Memory> {
  const current = await requireMemory(db, id);
  const text = validateMemoryText({ title: patch.title ?? current.title, body: patch.body ?? current.body });
  const [row] = await db
    .update(memories)
    .set({
      ...text,
      ...(patch.tags !== undefined && { tags: normalizeTags(patch.tags) }),
      ...(patch.kind !== undefined && { kind: patch.kind }),
    })
    .where(eq(memories.id, id))
    .returning(cols);
  return row!;
}

export async function deprecateMemory(db: Db, id: string, reason: string): Promise<{ changed: boolean }> {
  const r = reason.trim();
  if (!r) throw badRequest('reason must not be empty');
  const current = await requireMemory(db, id);
  if (current.status === 'deprecated') return { changed: false };
  await db.update(memories).set({ status: 'deprecated', deprecatedReason: r }).where(eq(memories.id, id));
  return { changed: true };
}

export async function deleteMemory(db: Db, id: string): Promise<void> {
  const deleted = await db.delete(memories).where(eq(memories.id, id)).returning({ id: memories.id });
  if (deleted.length === 0) throw notFound(`memory ${id} does not exist`);
}

export async function listMemories(
  db: Db,
  f: { projectId?: string; kind?: MemoryKind; status?: 'active' | 'deprecated' | 'all'; q?: string },
): Promise<Memory[]> {
  const status = f.status ?? 'active';
  const q = f.q?.trim();
  return db
    .select(cols)
    .from(memories)
    .where(
      and(
        f.projectId ? eq(memories.projectId, f.projectId) : undefined,
        f.kind ? eq(memories.kind, f.kind) : undefined,
        status !== 'all' ? eq(memories.status, status) : undefined,
        q ? sql`${memories.search} @@ websearch_to_tsquery('simple', ${q})` : undefined,
      ),
    )
    .orderBy(desc(memories.createdAt))
    .limit(500);
}

export const MEMORY_SORTS = ['createdAt', 'updatedAt', 'title', 'kind', 'projectId', 'status', 'source'] as const;
export type MemorySort = (typeof MEMORY_SORTS)[number];

export type MemoryFilter = {
  projectId?: string;
  kind?: MemoryKind;
  status?: 'active' | 'deprecated' | 'all';
  source?: 'agent' | 'human';
  /** Prefix search: every word must match the start of a word in title, tags or body. */
  q?: string;
};

/** The UI table: filter, sort and paginate on the server so no list is silently truncated. */
export async function pageMemories(db: Db, f: MemoryFilter & PageQuery<MemorySort>): Promise<Page<Memory>> {
  const { page, pageSize, limit, offset } = pageWindow(f);
  const status = f.status ?? 'active';
  const tsq = prefixTsQuery(f.q);
  const where = and(
    f.projectId ? eq(memories.projectId, f.projectId) : undefined,
    f.kind ? eq(memories.kind, f.kind) : undefined,
    f.source ? eq(memories.source, f.source) : undefined,
    status !== 'all' ? eq(memories.status, status) : undefined,
    tsq ? matchesPrefix(memories.search, tsq) : undefined,
  );
  const order = (f.dir ?? 'desc') === 'asc' ? asc : desc;
  const [items, [total]] = await Promise.all([
    db.select(cols).from(memories).where(where)
      .orderBy(order(memories[f.sort ?? 'createdAt']), desc(memories.createdAt), asc(memories.id))
      .limit(limit).offset(offset),
    db.select({ n: count() }).from(memories).where(where),
  ]);
  return { items, total: total?.n ?? 0, page, pageSize };
}

export async function supersedesChain(db: Db, id: string): Promise<Memory[]> {
  const start = await requireMemory(db, id);
  const seen = new Set([start.id]);
  const older: Memory[] = [];
  let cur = start;
  while (cur.supersedesId && !seen.has(cur.supersedesId)) {
    const prev = await getMemory(db, cur.supersedesId);
    if (!prev) break;
    seen.add(prev.id);
    older.unshift(prev);
    cur = prev;
  }
  const newer: Memory[] = [];
  cur = start;
  for (;;) {
    const [next] = await db.select(cols).from(memories).where(eq(memories.supersedesId, cur.id)).orderBy(memories.createdAt).limit(1);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    newer.push(next);
    cur = next;
  }
  return [...older, start, ...newer];
}

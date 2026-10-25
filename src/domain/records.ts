import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memories, notes, thoughts } from '../db/schema.js';
import { badRequest, notFound } from './errors.js';
import { parseIdRef } from './ids.js';
import { getMemory, type Memory } from './memories.js';
import { getNote, type Note } from './notes.js';
import { getThought, type Thought } from './thoughts.js';

export type ResolvedRecord =
  | { type: 'memory'; record: Memory }
  | { type: 'note'; record: Note }
  | { type: 'thought'; record: Thought };

export async function resolveRecord(db: Db, raw: string): Promise<ResolvedRecord> {
  const ref = parseIdRef(raw);
  const byId = async (id: string): Promise<ResolvedRecord | undefined> => {
    const m = await getMemory(db, id);
    if (m) return { type: 'memory', record: m };
    const n = await getNote(db, id);
    if (n) return { type: 'note', record: n };
    const t = await getThought(db, id);
    return t ? { type: 'thought', record: t } : undefined;
  };

  if (ref.kind === 'full') {
    const found = await byId(ref.id);
    if (!found) throw notFound(`no memory, note or thought has id ${ref.id}`);
    return found;
  }

  const pattern = `${ref.prefix}%`;
  const candidates = [
    ...(await db.select({ id: memories.id, title: memories.title }).from(memories)
      .where(sql`${memories.id}::text LIKE ${pattern}`).limit(6)).map((r) => ({ ...r, type: 'memory' })),
    ...(await db.select({ id: notes.id, title: notes.title }).from(notes)
      .where(sql`${notes.id}::text LIKE ${pattern}`).limit(6)).map((r) => ({ ...r, type: 'note' })),
    ...(await db.select({ id: thoughts.id, title: thoughts.title }).from(thoughts)
      .where(sql`${thoughts.id}::text LIKE ${pattern}`).limit(6)).map((r) => ({ ...r, type: 'thought' })),
  ];
  if (candidates.length === 0) throw notFound(`no memory, note or thought matches id "#${ref.prefix}"`);
  if (candidates.length > 1) {
    const list = candidates.map((c) => `${c.id} (${c.type}: ${c.title})`).join('; ');
    throw badRequest(`id "#${ref.prefix}" is ambiguous; it matches ${list}. Pass more characters.`);
  }
  return (await byId(candidates[0]!.id))!;
}

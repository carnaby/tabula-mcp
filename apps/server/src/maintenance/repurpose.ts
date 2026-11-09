import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memories, notes } from '../db/schema.js';

export const PROJECT_REASON = 'archived 2026-10: project memories replaced by synced files';
export const GLOBAL_REASON = 'archived 2026-10: project-specific, not a global rule';

export type Candidate = { id: string; project: string | null; title: string };
export type RepurposePlan = {
  /** Step 1: every active memory outside global. */
  projectMemories: Candidate[];
  /** Step 2: notes that still belong to a project; they move to the notebook. */
  projectNotes: Candidate[];
  /** All active global memories, so the owner can choose. */
  globalMemories: Candidate[];
  /** Step 3: the global memories the owner confirmed (by full uuid). */
  globalToArchive: Candidate[];
  /** Ids that are not active global memories. */
  unknownIds: string[];
};

const memoryCandidate = { id: memories.id, project: memories.projectId, title: memories.title };

export async function planRepurpose(db: Db, archiveGlobalIds: string[]): Promise<RepurposePlan> {
  const [projectMemories, projectNotes, globalMemories] = await Promise.all([
    db.select(memoryCandidate).from(memories)
      .where(and(ne(memories.projectId, 'global'), eq(memories.status, 'active')))
      .orderBy(asc(memories.projectId), asc(memories.createdAt)),
    db.select({ id: notes.id, project: notes.projectId, title: notes.title }).from(notes)
      .where(isNotNull(notes.projectId))
      .orderBy(asc(notes.createdAt)),
    db.select(memoryCandidate).from(memories)
      .where(and(eq(memories.projectId, 'global'), eq(memories.status, 'active')))
      .orderBy(asc(memories.createdAt)),
  ]);
  const wanted = [...new Set(archiveGlobalIds.map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const globalToArchive = globalMemories.filter((m) => wanted.includes(m.id));
  const unknownIds = wanted.filter((id) => !globalToArchive.some((m) => m.id === id));
  return { projectMemories, projectNotes, globalMemories, globalToArchive, unknownIds };
}

/** One transaction; running it again changes nothing. Refuses ids that are not active global memories. */
export async function applyRepurpose(db: Db, plan: RepurposePlan): Promise<{ archived: number; movedNotes: number }> {
  if (plan.unknownIds.length) throw new Error(`unknown or inactive global memory ids: ${plan.unknownIds.join(', ')}`);
  return db.transaction(async (tx) => {
    let archived = 0;
    const archive = async (ids: string[], reason: string) => {
      if (!ids.length) return;
      const rows = await tx
        .update(memories)
        .set({ status: 'deprecated', deprecatedReason: reason })
        .where(and(inArray(memories.id, ids), eq(memories.status, 'active')))
        .returning({ id: memories.id });
      archived += rows.length;
    };
    await archive(plan.projectMemories.map((m) => m.id), PROJECT_REASON);
    await archive(plan.globalToArchive.map((m) => m.id), GLOBAL_REASON);
    const noteIds = plan.projectNotes.map((n) => n.id);
    const moved = noteIds.length
      ? await tx
          .update(notes)
          .set({ projectId: null, updatedAt: sql`${notes.updatedAt}` })
          .where(and(inArray(notes.id, noteIds), isNotNull(notes.projectId)))
          .returning({ id: notes.id })
      : [];
    return { archived, movedNotes: moved.length };
  });
}

export function formatPlan(p: RepurposePlan): string {
  const list = (items: Candidate[]) =>
    items.length ? items.map((c) => `  ${c.id}  [${c.project ?? 'notebook'}] ${c.title}`).join('\n') : '  (none)';
  return [
    `1. Project memories to archive (${p.projectMemories.length}):`,
    list(p.projectMemories),
    `2. Project notes to move into the Notes notebook (${p.projectNotes.length}):`,
    list(p.projectNotes),
    `3. Global memories to archive, chosen with --archive-global (${p.globalToArchive.length}):`,
    list(p.globalToArchive),
    ...(p.unknownIds.length ? [`   Not active global memories (fix the ids): ${p.unknownIds.join(', ')}`] : []),
    `All active global memories (${p.globalMemories.length}), to choose from:`,
    list(p.globalMemories),
  ].join('\n');
}

export const USAGE =
  'Usage: node dist/maintenance/run-repurpose.js [--apply] [--archive-global=<uuid,uuid,...>]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict parsing: only `--apply` and `--archive-global=<full uuids>`, each at most once. Throws a usage error otherwise. */
export function parseArgs(argv: string[]): { apply: boolean; archiveGlobal: string[] } {
  let apply = false;
  let archiveGlobal: string[] | null = null;
  for (const a of argv) {
    if (a === '--apply') {
      if (apply) throw new Error(`duplicate --apply
${USAGE}`);
      apply = true;
    } else if (a.startsWith('--archive-global=')) {
      if (archiveGlobal) throw new Error(`duplicate --archive-global
${USAGE}`);
      const ids = a.slice('--archive-global='.length).split(',');
      const bad = ids.find((id) => !UUID.test(id));
      if (bad !== undefined) throw new Error(`--archive-global needs full comma-separated uuids, got "${bad}"
${USAGE}`);
      archiveGlobal = ids.map((id) => id.toLowerCase());
    } else {
      throw new Error(`unknown argument "${a}"
${USAGE}`);
    }
  }
  return { apply, archiveGlobal: archiveGlobal ?? [] };
}

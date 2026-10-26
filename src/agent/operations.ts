import type { Db } from '../db/client.js';
import { AGENT_READ_ONLY, badRequest, forbidden } from '../domain/errors.js';
import { createMemory, deprecateMemory, type Memory } from '../domain/memories.js';
import type { Note } from '../domain/notes.js';
import { listProjects, type ProjectSummary } from '../domain/projects.js';
import { recall } from '../domain/recall.js';
import { resolveRecord } from '../domain/records.js';
import { search, type SearchHit, type SearchParams } from '../domain/search.js';
import { createThought, findThoughts, type Thought, type ThoughtHit, updateThought } from '../domain/thoughts.js';
import type { MemoryKind } from '../domain/validation.js';

export type AgentContext = { db: Db; agentLabel: string };

const memoryView = (m: Memory) => ({
  type: 'memory' as const,
  id: m.id,
  project: m.projectId,
  kind: m.kind,
  title: m.title,
  body: m.body,
  tags: m.tags,
  status: m.status,
  source: m.source,
  agent_label: m.agentLabel,
  supersedes_id: m.supersedesId,
  deprecated_reason: m.deprecatedReason,
  created_at: m.createdAt.toISOString(),
  updated_at: m.updatedAt.toISOString(),
});

const noteView = (n: Note) => ({
  type: 'note' as const,
  id: n.id,
  project: n.projectId,
  title: n.title,
  summary: n.summary,
  body: n.body,
  tags: n.tags,
  pinned: n.pinned,
  created_at: n.createdAt.toISOString(),
  updated_at: n.updatedAt.toISOString(),
});

const thoughtView = (t: Thought) => ({
  type: 'thought' as const,
  id: t.id,
  title: t.title,
  body: t.body,
  tags: t.tags,
  pinned: t.pinned,
  archived: t.archived,
  version: t.version,
  edited_by: t.editedBy,
  created_at: t.createdAt.toISOString(),
  updated_at: t.updatedAt.toISOString(),
});

export type MemoryView = ReturnType<typeof memoryView>;
export type NoteView = ReturnType<typeof noteView>;
export type ThoughtView = ReturnType<typeof thoughtView>;

/** A record the agent may modify: only memories with source=agent. */
async function requireAgentWritable(db: Db, id: string): Promise<Memory> {
  const r = await resolveRecord(db, id);
  if (r.type === 'thought') throw badRequest(`${r.record.id} is a thought, not a memory; use update_thought`);
  if (r.type === 'note' || r.record.source === 'human') throw forbidden(AGENT_READ_ONLY);
  return r.record;
}

export const agentListProjects = (ctx: AgentContext): Promise<ProjectSummary[]> => listProjects(ctx.db);

export async function agentRecall(ctx: AgentContext, project: string): Promise<string> {
  return (await recall(ctx.db, project)).text;
}

export const agentSearch = (ctx: AgentContext, p: SearchParams): Promise<SearchHit[]> => search(ctx.db, p);

export async function agentGet(ctx: AgentContext, id: string): Promise<MemoryView | NoteView | ThoughtView> {
  const r = await resolveRecord(ctx.db, id);
  if (r.type === 'memory') return memoryView(r.record);
  return r.type === 'note' ? noteView(r.record) : thoughtView(r.record);
}

export async function agentRemember(
  ctx: AgentContext,
  input: { project: string; kind: MemoryKind; title: string; body: string; tags?: string[]; supersedes_id?: string },
): Promise<{ id: string }> {
  const supersedesId = input.supersedes_id ? (await requireAgentWritable(ctx.db, input.supersedes_id)).id : null;
  const m = await createMemory(ctx.db, {
    projectId: input.project,
    kind: input.kind,
    title: input.title,
    body: input.body,
    tags: input.tags,
    supersedesId,
    source: 'agent',
    agentLabel: ctx.agentLabel,
  });
  return { id: m.id };
}

export async function agentDeprecate(ctx: AgentContext, input: { id: string; reason: string }): Promise<{ ok: true }> {
  const m = await requireAgentWritable(ctx.db, input.id);
  await deprecateMemory(ctx.db, m.id, input.reason);
  return { ok: true };
}

const agentEditor = (ctx: AgentContext) => ({ source: 'agent' as const, label: ctx.agentLabel });

export async function agentSaveThought(
  ctx: AgentContext,
  input: { title: string; body: string; tags?: string[] },
): Promise<{ id: string; version: number }> {
  const t = await createThought(ctx.db, input, agentEditor(ctx));
  return { id: t.id, version: t.version };
}

/** Agents may edit any thought, including the human's; every content change keeps the old version as a revision. */
export async function agentUpdateThought(
  ctx: AgentContext,
  input: { id: string; title?: string; body?: string; append?: string; tags?: string[]; expected_version?: number },
): Promise<{ id: string; version: number }> {
  const r = await resolveRecord(ctx.db, input.id);
  if (r.type !== 'thought') throw badRequest(`${r.record.id} is a ${r.type}, not a thought`);
  if ((input.body !== undefined || input.title !== undefined) && input.expected_version === undefined) {
    throw badRequest(
      `expected_version is required when you pass body or title (a full replace). Call get or find_thoughts first to read the current version of ${r.record.id}, then pass it as expected_version. Only append may be sent without it.`,
    );
  }
  if (input.body !== undefined && input.append !== undefined) throw badRequest('pass either body (replace) or append, not both');
  const t = await updateThought(
    ctx.db,
    r.record.id,
    { title: input.title, body: input.body, append: input.append, tags: input.tags, expectedVersion: input.expected_version },
    agentEditor(ctx),
  );
  return { id: t.id, version: t.version };
}

export const agentFindThoughts = (
  ctx: AgentContext,
  p: { query?: string; tag?: string; limit?: number },
): Promise<ThoughtHit[]> => findThoughts(ctx.db, p);

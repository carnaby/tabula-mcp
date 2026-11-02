import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { AGENT_READ_ONLY, badRequest, forbidden, notFound } from '../domain/errors.js';
import { getFile, listFiles } from '../domain/files.js';
import { createMemory, deprecateMemory, type Memory } from '../domain/memories.js';
import { findNotes, type Note, type NoteHit } from '../domain/notes.js';
import { listProjects, type ProjectSummary } from '../domain/projects.js';
import { recall } from '../domain/recall.js';
import { resolveRecord } from '../domain/records.js';
import { search, type SearchHit, type SearchParams } from '../domain/search.js';
import { deleteSyncedFile, type SyncedWrite, writeSyncedFile } from '../domain/sync-config.js';
import type { FfmpegPaths } from '../media/ffmpeg.js';
import { signMediaPath } from '../media/sign.js';
import type { MediaStore } from '../media/store.js';
import {
  type Attachment, attachmentImage, createReport, frameAt, getReport, listAttachments, pageReports, parseTimestamp,
  type Report, type ReportStatus, type ReportStatusFilter, updateReport,
} from '../domain/reports.js';
import { createThought, findThoughts, type Thought, type ThoughtHit, updateThought } from '../domain/thoughts.js';
import type { MemoryKind } from '../domain/validation.js';

export type AgentMedia = {
  store: MediaStore;
  token: string;
  paths: FfmpegPaths;
  /** Origin the agent reached Tabula at, for absolute attachment links. */
  baseUrl?: string;
};
export type AgentContext = { db: Db; agentLabel: string; media?: AgentMedia };

/** Project memories were replaced by synced files; agents keep only the global rules, and only on request. */
export const GLOBAL_ONLY =
  'Tabula keeps no project memories: remember and deprecate work only on global rules (project "global"), and only when the user explicitly asks. Project knowledge belongs in the repository or in its synced files (tabula push). Do not retry with project "global" unless the user asked for a rule that applies to every project.';

/** read_file returns at most this many characters per call. */
export const READ_CHUNK = 100_000;

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
export type AgentFile = {
  path: string; size: number; version: number; sha256: string; state: boolean; updated_at: string; updated_by: string;
};
/** read_file's reply: a header line with the version and hash, the text exactly as stored, and a pointer to the next part. */
export type AgentFileRead = { header: string; text?: string; footer?: string };

/** A record the agent may modify: a global memory written by an agent. */
async function requireAgentWritable(db: Db, id: string): Promise<Memory> {
  const r = await resolveRecord(db, id);
  if (r.type === 'thought') throw badRequest(`${r.record.id} is a thought, not a memory; use update_thought`);
  if (r.type === 'report') throw badRequest(`${r.record.id} is a bug report, not a memory; use update_report`);
  if (r.type === 'note' || r.record.source === 'human') throw forbidden(AGENT_READ_ONLY);
  if (r.record.projectId !== 'global') throw badRequest(GLOBAL_ONLY);
  return r.record;
}

export const agentListProjects = (ctx: AgentContext): Promise<ProjectSummary[]> => listProjects(ctx.db);

export async function agentRecall(ctx: AgentContext, project: string, includeState = true): Promise<string> {
  return (await recall(ctx.db, project, { includeState })).text;
}

export const agentSearch = (ctx: AgentContext, p: SearchParams): Promise<SearchHit[]> => search(ctx.db, p);

export async function agentGet(ctx: AgentContext, id: string): Promise<MemoryView | NoteView | ThoughtView | Record<string, unknown>> {
  const r = await resolveRecord(ctx.db, id);
  if (r.type === 'memory') return memoryView(r.record);
  if (r.type === 'report') return { type: 'report' as const, ...reportForAgent(r.record), next: 'call get_report for its attachments' };
  return r.type === 'note' ? noteView(r.record) : thoughtView(r.record);
}

export async function agentRemember(
  ctx: AgentContext,
  input: { project: string; kind: MemoryKind; title: string; body: string; tags?: string[]; supersedes_id?: string },
): Promise<{ id: string }> {
  if (input.project !== 'global') throw badRequest(GLOBAL_ONLY);
  const supersedesId = input.supersedes_id ? (await requireAgentWritable(ctx.db, input.supersedes_id)).id : null;
  const m = await createMemory(ctx.db, {
    projectId: 'global',
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

export async function agentListFiles(ctx: AgentContext, project: string): Promise<AgentFile[]> {
  return (await listFiles(ctx.db, project)).map((f) => ({
    path: f.path, size: f.size, version: f.version, sha256: f.sha256, state: f.isState,
    updated_at: f.updatedAt.toISOString(), updated_by: f.updatedBy,
  }));
}

/** The file's text from offset, at most READ_CHUNK characters; the footer names the next offset. */
export async function agentReadFile(
  ctx: AgentContext, input: { project: string; path: string; offset?: number },
): Promise<AgentFileRead> {
  const f = await getFile(ctx.db, input.project, input.path);
  if (f.deletedAt) throw notFound(`file "${f.path}" was deleted in project "${input.project}"; call list_files for the current files`);
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const total = f.content.length;
  if (offset > 0 && offset >= total) return { header: `[offset ${offset} is past the end of the file (${total} characters)]` };
  let end = Math.min(total, offset + READ_CHUNK);
  // Never split a surrogate pair: end one code unit earlier so the next chunk starts on the whole pair.
  if (end < total) {
    const last = f.content.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  const from = offset > 0 ? ` · from character ${offset}` : '';
  const header = `[file ${f.path} · version ${f.version} · sha256 ${f.sha256} · ${total} characters${from}]`;
  const text = f.content.slice(offset, end);
  if (end === total) return { header, text };
  return { header, text, footer: `[… part ends at character ${end} of ${total} — call read_file again with offset: ${end}]` };
}

/** Agents without the tabula command (Claude Code on the web, claude.ai) save synced files with this. */
export const agentWriteFile = (
  ctx: AgentContext, input: { project: string; path: string; content: string; base_sha256?: string },
): Promise<SyncedWrite> =>
  writeSyncedFile(ctx.db, input.project, { path: input.path, content: input.content, baseSha256: input.base_sha256 ?? null }, ctx.agentLabel);

export const agentDeleteFile = (
  ctx: AgentContext, input: { project: string; path: string; base_sha256: string },
): Promise<{ path: string; deleted: true }> => deleteSyncedFile(ctx.db, input.project, { path: input.path, baseSha256: input.base_sha256 });

export const agentFindNotes = (
  ctx: AgentContext,
  p: { query?: string; tag?: string; limit?: number },
): Promise<NoteHit[]> => findNotes(ctx.db, p);

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

// ---- Bug reports -------------------------------------------------------------------------------------------------

/** Links in agent replies last a day: long enough to download in the same session. */
const AGENT_LINK_TTL = 24 * 3600;

function requireMedia(ctx: AgentContext): AgentMedia {
  if (!ctx.media) throw new Error('media storage is not configured for this MCP context');
  return ctx.media;
}

const seconds = (ms: number | null) => (ms === null ? null : Math.round(ms / 100) / 10);

const attachmentForAgent = (a: Attachment, m: AgentMedia) => ({
  id: a.id,
  kind: a.kind,
  mime: a.mime,
  size: a.size,
  file_name: a.fileName,
  duration_s: seconds(a.durationMs),
  ...(a.kind === 'frame' ? { from_video: a.sourceId, at_s: seconds(a.atMs) } : {}),
  added_by: a.createdBy,
  ...(a.purgedAt
    ? { deleted: 'deleted after the report was closed' }
    : { url: `${m.baseUrl ?? ''}${signMediaPath(m.token, a.id, AGENT_LINK_TTL)}` }),
});

const reportForAgent = (r: Report) => ({
  id: r.id,
  project: r.projectId,
  title: r.title,
  status: r.status,
  description: r.body,
  triage: r.triage,
  version: r.version,
  edited_by: r.editedBy,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
  closed_at: r.closedAt?.toISOString() ?? null,
});

const agentEditorOf = (ctx: AgentContext) => ({ source: 'agent' as const, label: ctx.agentLabel });

export async function agentListReports(
  ctx: AgentContext,
  p: { project?: string; status?: ReportStatusFilter; query?: string; limit?: number },
) {
  const page = await pageReports(ctx.db, { projectId: p.project, status: p.status, q: p.query, pageSize: p.limit ?? 20 });
  return {
    total: page.total,
    reports: page.items.map((r) => ({
      id: r.id, project: r.projectId, title: r.title, status: r.status, created_at: r.createdAt.toISOString(),
      attachments: r.counts, has_triage: r.triage.length > 0,
    })),
  };
}

async function requireReportRef(ctx: AgentContext, id: string): Promise<Report> {
  const r = await resolveRecord(ctx.db, id);
  if (r.type !== 'report') throw badRequest(`${r.record.id} is a ${r.type}, not a bug report`);
  return r.record;
}

export async function agentGetReport(ctx: AgentContext, id: string) {
  const m = requireMedia(ctx);
  const r = await requireReportRef(ctx, id);
  const files = await listAttachments(ctx.db, r.id);
  return { ...reportForAgent(r), attachments: files.map((a) => attachmentForAgent(a, m)) };
}

export async function agentCreateReport(ctx: AgentContext, input: { project: string; title: string; description?: string }) {
  const r = await createReport(ctx.db, { projectId: input.project, title: input.title, body: input.description }, agentEditorOf(ctx));
  return { id: r.id, version: r.version };
}

export async function agentUpdateReport(
  ctx: AgentContext,
  input: { id: string; triage?: string; append_triage?: string; status?: ReportStatus; title?: string; expected_version?: number },
) {
  const r = await requireReportRef(ctx, input.id);
  if (input.triage !== undefined && input.append_triage !== undefined) throw badRequest('pass either triage (replace) or append_triage, not both');
  // Replacing text, or closing (which starts the deletion of the report's video and audio), must not be based on
  // a stale read.
  if ((input.triage !== undefined || input.title !== undefined || input.status === 'done') && input.expected_version === undefined) {
    throw badRequest('expected_version is required when you replace triage or title or set status "done"; read it with get_report first. append_triage and status "triaged" may be sent without it.');
  }
  const out = await updateReport(
    ctx.db,
    r.id,
    { triage: input.triage, appendTriage: input.append_triage, status: input.status, title: input.title, expectedVersion: input.expected_version },
    agentEditorOf(ctx),
  );
  return { id: out.id, version: out.version, status: out.status };
}

export type AgentImage = { image: Buffer; mime: string; text: string };

export async function agentViewAttachment(ctx: AgentContext, id: string): Promise<AgentImage> {
  const m = requireMedia(ctx);
  const { attachment, image, mime } = await attachmentImage(ctx.db, m.store, m.paths, await resolveAttachmentId(ctx, id));
  return { image, mime, text: JSON.stringify(attachmentForAgent(attachment, m)) };
}

export async function agentGetFrame(ctx: AgentContext, input: { video_id: string; at: string | number }): Promise<AgentImage> {
  const m = requireMedia(ctx);
  const { frame, created } = await frameAt(ctx.db, m.store, m.paths, await resolveAttachmentId(ctx, input.video_id), parseTimestamp(input.at), agentEditorOf(ctx));
  const { image } = await attachmentImage(ctx.db, m.store, m.paths, frame.id);
  return { image, mime: 'image/jpeg', text: JSON.stringify({ ...attachmentForAgent(frame, m), saved: created ? 'new frame saved to the report' : 'this frame was already saved' }) };
}

/** Attachments are referenced by full uuid or by a prefix of 8+ hex characters (they never appear in the digest). */
async function resolveAttachmentId(ctx: AgentContext, raw: string): Promise<string> {
  const v = raw.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return v;
  if (!/^[0-9a-f][0-9a-f-]{7,35}$/.test(v)) throw badRequest(`attachment id "${raw}" must be a uuid or its first 8+ characters`);
  const rows = await ctx.db.execute<{ id: string }>(sql`SELECT id FROM report_attachments WHERE id::text LIKE ${`${v}%`} LIMIT 2`);
  const list = [...rows];
  if (list.length === 0) throw notFound(`no attachment matches "${raw}"`);
  if (list.length > 1) throw badRequest(`attachment id "${raw}" is ambiguous; pass more characters`);
  return list[0]!.id;
}

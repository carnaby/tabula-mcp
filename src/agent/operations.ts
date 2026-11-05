import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { AGENT_READ_ONLY, badRequest, forbidden, notFound } from '../domain/errors.js';
import { getFile, listFiles, type ProjectFile } from '../domain/files.js';
import { isRecording, lastWorkerSeen, type TranscriptState, transcriptStates } from '../domain/jobs.js';
import { createMemory, deprecateMemory, type Memory } from '../domain/memories.js';
import { findNotes, type Note, type NoteHit } from '../domain/notes.js';
import { listProjects, type ProjectSummary } from '../domain/projects.js';
import { recall } from '../domain/recall.js';
import { parseIdRef } from '../domain/ids.js';
import { refTarget, type ResolvedRecord, resolveRecord } from '../domain/records.js';
import { search, type SearchHit, type SearchParams } from '../domain/search.js';
import { deleteSyncedFile, type SyncedWrite, writeSyncedFile } from '../domain/sync-config.js';
import type { FfmpegPaths } from '../media/ffmpeg.js';
import { signMediaPath } from '../media/sign.js';
import type { MediaStore } from '../media/store.js';
import {
  type Attachment, attachmentImage, createReport, frameAt, getReport, listAttachments, pageReports, parseTimestamp,
  type Report, requireAttachment, type ReportStatus, type ReportStatusFilter, updateReport,
} from '../domain/reports.js';
import { clock, sliceLines, transcriptLines } from '../domain/transcripts.js';
import { createThought, findThoughts, type Thought, type ThoughtHit, updateThought } from '../domain/thoughts.js';
import type { MemoryKind } from '../domain/validation.js';
import { refOf } from '../shared/refs.js';

export type AgentMedia = {
  store: MediaStore;
  token: string;
  paths: FfmpegPaths;
  /** Origin the agent reached Tabula at, for absolute attachment links. */
  baseUrl?: string;
};
/** `workerEnabled`: the server has a TABULA_WORKER_TOKEN, so a transcription worker can connect (absent = yes). */
export type AgentContext = { db: Db; agentLabel: string; media?: AgentMedia; workerEnabled?: boolean };

/** Project memories were replaced by synced files; agents keep only the global rules, and only on request. */
export const GLOBAL_ONLY =
  'Tabula keeps no project memories: remember and deprecate work only on global rules (project "global"), and only when the user explicitly asks. Project knowledge belongs in the repository or in its synced files (tabula push). Do not retry with project "global" unless the user asked for a rule that applies to every project.';

/** read_file returns at most this many characters per call. */
export const READ_CHUNK = 100_000;

const memoryView = (m: Memory) => ({
  type: 'memory' as const,
  ref: refOf(m.id),
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
  ref: refOf(n.id),
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
  ref: refOf(t.id),
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
  path: string; ref: string; size: number; version: number; sha256: string; state: boolean; updated_at: string; updated_by: string;
};
/** read_file's reply: a header line with the version and hash, the text exactly as stored, and a pointer to the next part. */
export type AgentFileRead = { header: string; text?: string; footer?: string };

/** A reply in separate MCP content blocks: text, or an image. */
export type AgentBlock = { type: 'text'; text: string } | { type: 'image'; image: Buffer; mime: string };
const textBlock = (text: string): AgentBlock => ({ type: 'text', text });
const jsonBlock = (value: unknown): AgentBlock => textBlock(JSON.stringify(value));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const ATTACHMENT_WORD = { frame: 'frame', image: 'photo', video: 'video', audio: 'voice note' } as const;

/** What a record is for the headline, and its state when it is not active. */
function describeRecord(r: ResolvedRecord): { what: string; inactive?: string } {
  switch (r.type) {
    case 'memory':
      return {
        what: `${r.record.projectId === 'global' ? 'global ' : ''}${r.record.kind}`,
        inactive: r.record.status === 'deprecated' ? 'deprecated' : undefined,
      };
    case 'note':
      return { what: 'note' };
    case 'thought':
      return { what: 'thought', inactive: r.record.archived ? 'archived' : undefined };
    case 'report':
      return { what: 'bug report', inactive: r.record.status === 'done' ? 'closed' : undefined };
    case 'file':
      return { what: 'project file', inactive: r.record.deletedAt ? `deleted ${isoDay(r.record.deletedAt)}` : undefined };
    case 'attachment':
      return {
        what: `${ATTACHMENT_WORD[r.record.kind]} of bug report ${refOf(r.report.id)}`,
        inactive: r.record.purgedAt ? 'recording deleted' : undefined,
      };
  }
}

/** The first line of get: reference · what it is · project · its state when not active · title. */
export function recordHeadline(r: ResolvedRecord): string {
  const t = refTarget(r);
  const { what, inactive } = describeRecord(r);
  const project = t.project && t.project !== 'global' ? [`project ${t.project}`] : [];
  return [t.ref, what, ...project, ...(inactive ? [inactive] : []), t.title].join(' · ');
}

/** Where a part of at most READ_CHUNK characters starting at offset ends; never inside a surrogate pair. */
function chunkEnd(content: string, offset: number): number {
  let end = Math.min(content.length, offset + READ_CHUNK);
  if (end < content.length) {
    const last = content.charCodeAt(end - 1);
    // End one code unit earlier so the next part starts on the whole pair.
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return end;
}

/** read_file's header line, which get repeats for a file. */
function fileHeader(f: ProjectFile, offset: number): string {
  const from = offset > 0 ? ` · from character ${offset}` : '';
  return `[file ${f.path} · ${refOf(f.id)} · version ${f.version} · sha256 ${f.sha256} · ${f.content.length} characters${from}]`;
}

/** A file as get shows it: like read_file's first part; a deleted file with its last content. */
function fileBlocks(f: ProjectFile): AgentBlock[] {
  const total = f.content.length;
  const end = chunkEnd(f.content, 0);
  const blocks: AgentBlock[] = [];
  if (f.deletedAt) {
    blocks.push(textBlock(
      `[deleted on ${isoDay(f.deletedAt)}: below is its last content; the user can restore it in the Tabula app (project ${f.projectId} → Files → Show deleted); until then read_file and write_file treat it as absent]`,
    ));
  }
  blocks.push(textBlock(fileHeader(f, 0)), textBlock(f.content.slice(0, end)));
  if (end < total) {
    blocks.push(textBlock(f.deletedAt
      ? `[… part ends at character ${end} of ${total}; the rest can be read once the user restores the file]`
      : `[… part ends at character ${end} of ${total} — call read_file with project "${f.projectId}", path "${f.path}" and offset: ${end}]`));
  }
  return blocks;
}

/** A photo or frame as an image with its details; a video or voice note as details and where its transcript is. */
async function attachmentBlocks(ctx: AgentContext, a: Attachment, report: Report): Promise<AgentBlock[]> {
  const isImage = a.kind === 'frame' || a.kind === 'image';
  // Only an image needs the media store; a purged recording has no link, so it needs nothing.
  const m = isImage || !a.purgedAt ? requireMedia(ctx) : ctx.media;
  const view = { ...attachmentForAgent(a, m), report: refOf(report.id), report_title: report.title };
  if (isImage) {
    const { image, mime } = await attachmentImage(ctx.db, m!.store, m!.paths, a.id);
    return [{ type: 'image', image, mime }, jsonBlock(view)];
  }
  const s = (await transcriptStates(ctx.db, [a.id])).get(a.id);
  const lastSeen = isRecording(a) && s?.status !== 'done' ? await lastWorkerSeen(ctx.db) : null;
  return [jsonBlock({
    ...view,
    ...transcriptForAgent(a, s, lastSeen, ctx.workerEnabled !== false),
    next: `call get_report with id "${refOf(report.id)}" for the report and the first part of the transcript, and get_transcript with attachment_id "${refOf(a.id)}" for all of it`,
  })];
}

/** A record the agent may modify: a global memory written by an agent. */
async function requireAgentWritable(db: Db, id: string): Promise<Memory> {
  const r = await resolveRecord(db, id);
  if (r.type === 'thought') throw badRequest(`${r.record.id} is a thought, not a memory; use update_thought`);
  if (r.type === 'report') throw badRequest(`${r.record.id} is a bug report, not a memory; use update_report`);
  if (r.type === 'file' || r.type === 'attachment') {
    throw badRequest(`${r.record.id} is a ${r.type === 'file' ? 'project file' : 'bug report attachment'}, not a memory`);
  }
  if (r.type === 'note' || r.record.source === 'human') throw forbidden(AGENT_READ_ONLY);
  if (r.record.projectId !== 'global') throw badRequest(GLOBAL_ONLY);
  return r.record;
}

export const agentListProjects = (ctx: AgentContext): Promise<ProjectSummary[]> => listProjects(ctx.db);

export async function agentRecall(ctx: AgentContext, project: string, includeState = true): Promise<string> {
  return (await recall(ctx.db, project, { includeState })).text;
}

export const agentSearch = async (ctx: AgentContext, p: SearchParams): Promise<Array<SearchHit & { ref: string }>> =>
  (await search(ctx.db, p)).map((h) => ({ ref: refOf(h.id), ...h }));

/** Any record by reference, uuid or short id; the first block always says what it is. */
export async function agentGet(ctx: AgentContext, id: string): Promise<AgentBlock[]> {
  const r = await resolveRecord(ctx.db, id);
  const head = textBlock(recordHeadline(r));
  switch (r.type) {
    case 'memory':
      return [head, jsonBlock(memoryView(r.record))];
    case 'note':
      return [head, jsonBlock(noteView(r.record))];
    case 'thought':
      return [head, jsonBlock(thoughtView(r.record))];
    case 'report':
      return [head, jsonBlock({
        type: 'report' as const, ...reportForAgent(r.record),
        next: `call get_report with id "${refOf(r.record.id)}" for its attachments and transcripts`,
      })];
    case 'file':
      return [head, ...fileBlocks(r.record)];
    case 'attachment':
      return [head, ...(await attachmentBlocks(ctx, r.record, r.report))];
  }
}

export async function agentRemember(
  ctx: AgentContext,
  input: { project: string; kind: MemoryKind; title: string; body: string; tags?: string[]; supersedes_id?: string },
): Promise<{ id: string; ref: string }> {
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
  return { id: m.id, ref: refOf(m.id) };
}

export async function agentDeprecate(ctx: AgentContext, input: { id: string; reason: string }): Promise<{ ok: true }> {
  const m = await requireAgentWritable(ctx.db, input.id);
  await deprecateMemory(ctx.db, m.id, input.reason);
  return { ok: true };
}

export async function agentListFiles(ctx: AgentContext, project: string): Promise<AgentFile[]> {
  return (await listFiles(ctx.db, project)).map((f) => ({
    path: f.path, ref: refOf(f.id), size: f.size, version: f.version, sha256: f.sha256, state: f.isState,
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
  const end = chunkEnd(f.content, offset);
  const header = fileHeader(f, offset);
  const text = f.content.slice(offset, end);
  if (end === total) return { header, text };
  return { header, text, footer: `[… part ends at character ${end} of ${total} — call read_file again with offset: ${end}]` };
}

/** Agents without the tabula command (Claude Code on the web, claude.ai) save synced files with this. */
export async function agentWriteFile(
  ctx: AgentContext, input: { project: string; path: string; content: string; base_sha256?: string },
): Promise<SyncedWrite & { ref: string }> {
  const w = await writeSyncedFile(ctx.db, input.project, { path: input.path, content: input.content, baseSha256: input.base_sha256 ?? null }, ctx.agentLabel);
  return { ...w, ref: refOf((await getFile(ctx.db, input.project, w.path)).id) };
}

export const agentDeleteFile = (
  ctx: AgentContext, input: { project: string; path: string; base_sha256: string },
): Promise<{ path: string; deleted: true }> => deleteSyncedFile(ctx.db, input.project, { path: input.path, baseSha256: input.base_sha256 });

export const agentFindNotes = async (
  ctx: AgentContext,
  p: { query?: string; tag?: string; limit?: number },
): Promise<Array<NoteHit & { ref: string }>> => (await findNotes(ctx.db, p)).map((h) => ({ ref: refOf(h.id), ...h }));

const agentEditor = (ctx: AgentContext) => ({ source: 'agent' as const, label: ctx.agentLabel });

export async function agentSaveThought(
  ctx: AgentContext,
  input: { title: string; body: string; tags?: string[] },
): Promise<{ id: string; ref: string; version: number }> {
  const t = await createThought(ctx.db, input, agentEditor(ctx));
  return { id: t.id, ref: refOf(t.id), version: t.version };
}

/** Agents may edit any thought, including the human's; every content change keeps the old version as a revision. */
export async function agentUpdateThought(
  ctx: AgentContext,
  input: { id: string; title?: string; body?: string; append?: string; tags?: string[]; expected_version?: number },
): Promise<{ id: string; ref: string; version: number }> {
  const r = await resolveRecord(ctx.db, input.id);
  if (r.type !== 'thought') throw badRequest(`${r.record.id} is ${aOrAn(r.type)}, not a thought`);
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
  return { id: t.id, ref: refOf(t.id), version: t.version };
}

export const agentFindThoughts = async (
  ctx: AgentContext,
  p: { query?: string; tag?: string; limit?: number },
): Promise<Array<ThoughtHit & { ref: string }>> => (await findThoughts(ctx.db, p)).map((h) => ({ ref: refOf(h.id), ...h }));

// ---- Bug reports -------------------------------------------------------------------------------------------------

/** Links in agent replies last a day: long enough to download in the same session. */
const AGENT_LINK_TTL = 24 * 3600;

const aOrAn = (noun: string) => (/^[aeiou]/.test(noun) ? 'an ' : 'a ') + noun;

function requireMedia(ctx: AgentContext): AgentMedia {
  if (!ctx.media) throw new Error('media storage is not configured for this MCP context');
  return ctx.media;
}

const seconds = (ms: number | null) => (ms === null ? null : Math.round(ms / 100) / 10);

function attachmentUrl(a: Attachment, m: AgentMedia | undefined): string {
  if (!m) throw new Error('media storage is not configured for this MCP context');
  return `${m.baseUrl ?? ''}${signMediaPath(m.token, a.id, AGENT_LINK_TTL)}`;
}

const attachmentForAgent = (a: Attachment, m: AgentMedia | undefined) => ({
  id: a.id,
  ref: refOf(a.id),
  kind: a.kind,
  mime: a.mime,
  size: a.size,
  file_name: a.fileName,
  duration_s: seconds(a.durationMs),
  ...(a.kind === 'frame' ? { from_video: a.sourceId, at_s: seconds(a.atMs), ...(a.note ? { note: a.note } : {}) } : {}),
  added_by: a.createdBy,
  ...(a.purgedAt
    ? { deleted: 'deleted after the report was closed' }
    : { url: attachmentUrl(a, m) }),
});

/** Characters of each transcript shown inside get_report; get_transcript pages through the rest. */
const REPORT_TRANSCRIPT_CHARS = 6_000;
/** One part of get_transcript. */
export const TRANSCRIPT_CHUNK = 50_000;

function ago(d: Date, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - d.getTime()) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** Why a recording has no transcript (yet), in words an agent can pass on. */
function pendingText(s: TranscriptState | undefined, lastSeen: Date | null, workerEnabled = true): string {
  if (!workerEnabled) return 'transcription is not enabled on this server (no TABULA_WORKER_TOKEN); recordings stay untranscribed until the owner enables it';
  if (!s || s.status === 'none') {
    return 'it was not queued for transcription (a video without sound, or uploaded before the worker existed); the user can start it with "Transcribe" in the Tabula app';
  }
  if (s.status === 'running') return 'it is being transcribed right now; ask again in a minute';
  if (s.status === 'failed') return `the transcription failed (${s.error ?? 'unknown error'}); the user can retry it in the Tabula app`;
  const seen = lastSeen ? `last seen ${ago(lastSeen)}` : 'it has never connected';
  return `waiting for the transcription worker (${seen}); the user starts it on their PC with \`tabula worker --once\``;
}

function transcriptForAgent(a: Attachment, s: TranscriptState | undefined, lastSeen: Date | null, workerEnabled: boolean) {
  if (!isRecording(a)) return {};
  if (s?.status !== 'done') return { transcript: { status: s?.status ?? 'none', note: pendingText(s, lastSeen, workerEnabled) } };
  const lines = transcriptLines(s.segments);
  if (!lines) return { transcript: { status: 'done', language: s.language, text: '', note: 'no speech in the recording' } };
  const part = sliceLines(lines, 0, REPORT_TRANSCRIPT_CHARS);
  return {
    transcript: {
      status: 'done',
      language: s.language,
      text: part.text,
      ...(part.next !== null
        ? { more: `the transcript continues (${lines.length} characters): call get_transcript with attachment_id "${refOf(a.id)}" and offset ${part.next}` }
        : {}),
    },
  };
}

const reportForAgent = (r: Report) => ({
  id: r.id,
  ref: refOf(r.id),
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
      id: r.id, ref: refOf(r.id), project: r.projectId, title: r.title, status: r.status, created_at: r.createdAt.toISOString(),
      attachments: r.counts, has_triage: r.triage.length > 0,
    })),
  };
}

async function requireReportRef(ctx: AgentContext, id: string): Promise<Report> {
  const r = await resolveRecord(ctx.db, id);
  if (r.type === 'attachment') {
    throw badRequest(
      `${r.record.id} is an attachment of bug report ${refOf(r.report.id)}, not a bug report; use get with it to see the attachment, or pass the report's reference`,
    );
  }
  if (r.type !== 'report') throw badRequest(`${r.record.id} is ${aOrAn(r.type)}, not a bug report`);
  return r.record;
}

export async function agentGetReport(ctx: AgentContext, id: string) {
  const m = requireMedia(ctx);
  const r = await requireReportRef(ctx, id);
  const files = await listAttachments(ctx.db, r.id);
  const states = await transcriptStates(ctx.db, files.filter(isRecording).map((a) => a.id));
  const waiting = files.some((a) => isRecording(a) && states.get(a.id)?.status !== 'done');
  const lastSeen = waiting ? await lastWorkerSeen(ctx.db) : null;
  return {
    ...reportForAgent(r),
    attachments: files.map((a) => ({ ...attachmentForAgent(a, m), ...transcriptForAgent(a, states.get(a.id), lastSeen, ctx.workerEnabled !== false) })),
  };
}

export async function agentCreateReport(ctx: AgentContext, input: { project: string; title: string; description?: string }) {
  const r = await createReport(ctx.db, { projectId: input.project, title: input.title, body: input.description }, agentEditorOf(ctx));
  return { id: r.id, ref: refOf(r.id), version: r.version };
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
  return { id: out.id, ref: refOf(out.id), version: out.version, status: out.status };
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

/** Attachments are named by their reference (tabula:xxxxxxxx), a full uuid or a prefix of its hex characters. */
async function resolveAttachmentId(ctx: AgentContext, raw: string): Promise<string> {
  const ref = parseIdRef(raw);
  if (ref.kind === 'full') return ref.id;
  const rows = await ctx.db.execute<{ id: string }>(sql`SELECT id FROM report_attachments WHERE replace(id::text, '-', '') LIKE ${`${ref.prefix}%`} LIMIT 2`);
  const list = [...rows];
  if (list.length === 0) throw notFound(`no attachment matches "${raw}"`);
  if (list.length > 1) throw badRequest(`attachment id "${raw}" is ambiguous; pass more characters`);
  return list[0]!.id;
}

/** The whole transcript of a recording, in parts of TRANSCRIPT_CHUNK characters cut at line breaks. */
export async function agentGetTranscript(ctx: AgentContext, input: { attachment_id: string; offset?: number }): Promise<string> {
  const id = await resolveAttachmentId(ctx, input.attachment_id);
  const a = await requireAttachment(ctx.db, id);
  if (!isRecording(a)) throw badRequest(`attachment ${id} is ${a.kind === 'image' ? 'a photo' : 'a frame'}; only video and audio are transcribed`);
  const s = (await transcriptStates(ctx.db, [id])).get(id);
  if (s?.status !== 'done') throw notFound(`attachment ${id} has no transcript yet: ${pendingText(s, await lastWorkerSeen(ctx.db), ctx.workerEnabled !== false)}`);
  const lines = transcriptLines(s.segments);
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  if (offset > 0 && offset >= lines.length) return `[offset ${offset} is past the end of the transcript (${lines.length} characters)]`;
  const part = sliceLines(lines, offset, TRANSCRIPT_CHUNK);
  const head = [
    `transcript of ${a.fileName}`,
    ...(a.durationMs !== null ? [clock(a.durationMs)] : []),
    s.language ?? 'language unknown',
    `${lines.length} characters${offset ? ` · from character ${offset}` : ''}`,
  ].join(' · ');
  const footer = part.next !== null ? [`[… part ends at character ${part.next} of ${lines.length} — call get_transcript again with offset: ${part.next}]`] : [];
  return [`[${head}]`, part.text || '(no speech in the recording)', ...footer].join('\n');
}

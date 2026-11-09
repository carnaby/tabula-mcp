import { ACTIVITY_DAYS } from '@tabula/shared/activity';
import { refOf } from '@tabula/shared/refs';
import { and, eq, gte, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.js';
import {
  notes, projectFileRevisions, projectFiles, reportAttachments, reports, reportTranscripts, thoughtRevisions, thoughts,
} from '../db/schema.js';
import { badRequest } from './errors.js';

export const ACTIVITY_TYPES = ['files', 'reports', 'thoughts', 'notes'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
/** File versions of one project and author whose neighbours are at most this far apart make one row. */
export const FILE_BATCH_GAP_MS = 5 * 60_000;
/** Changes of one record by one author within this time of the group's first change make one row. */
export const RECORD_MERGE_MS = 60 * 60_000;
/** A report's updated_at this close to an upload or to closed_at was set by that upload or by closing. */
const SAME_WRITE_MS = 2000;
/** Who transcribes recordings. */
export const WORKER = 'worker';
const HUMAN = 'human';

/** One change before merging. */
export type ActivityEvent = {
  kind: 'file' | 'report' | 'transcript' | 'thought' | 'note';
  /** The changed record: a file, report, recording (for a transcript), thought or note. */
  recordId: string;
  title: string;
  project: string | null;
  /** 'human', 'cli', an agent's label, or 'worker'. */
  by: string;
  at: Date;
  /** This change created the record (version 1, a new report or note). */
  create: boolean;
  /** What a record's row says (file rows build their own). */
  action: string;
  /** Files: the path. */
  path?: string;
  /** Transcripts: the report of the recording. */
  reportId?: string;
};

export type ActivityChild = { id: string; path: string; ref: string };

export type ActivityItem = {
  type: 'file' | 'report' | 'thought' | 'note';
  action: string;
  ref: string;
  /** The record to open: the file (the newest of a batch), report, thought or note. */
  id: string;
  title: string;
  project: string | null;
  by: string;
  /** The row's last change (ISO). */
  at: string;
  /** A batch of two or more files: how many. */
  count?: number;
  /** One file: its path. */
  path?: string;
  /** "Transcribed": the recording (the row's ref is the recording's). */
  attachment_id?: string;
  /** A batch of two or more files, newest first. */
  children?: ActivityChild[];
};

export type ActivityDay = { date: string; items: ActivityItem[] };
export type ActivityPage = { days: ActivityDay[]; next_before: string | null };

// ---------- Days in a time zone ----------

/** The zone name, or a 400 when the runtime doesn't know it. */
export function checkTimeZone(tz: string): string {
  try {
    // The canonical name, so differently spelled names share one cached formatter.
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    throw badRequest(`tz "${tz}" is not a time zone name such as Europe/Bratislava`);
  }
}

/** Keyed by the canonical zone name that checkTimeZone returns, so the cache holds one entry per real zone. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function wallClock(at: Date, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), s: Number(p.second) };
}
const pad = (n: number) => String(n).padStart(2, '0');

/** The calendar day of an instant in a time zone, as YYYY-MM-DD. */
export function localDate(at: Date, tz: string): string {
  const w = wallClock(at, tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

/** YYYY-MM-DD plus n days (n may be negative). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** The first instant of a calendar day in a time zone. */
export function dayStart(date: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const midnight = Date.UTC(y!, m! - 1, d!);
  let at = midnight;
  // The zone's offset near the answer; twice, because the offset at UTC midnight may differ from the one at local midnight.
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(at), tz);
    const offset = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(at / 1000) * 1000;
    at = midnight - offset;
  }
  const isDate = (t: number) => localDate(new Date(t), tz) >= date;
  if (isDate(at) && !isDate(at - 1)) return new Date(at);
  // A day that begins with a jump: midnight does not exist (the clock skips from 23:59 to 01:00) or the first hour
  // repeats (01:00 back to 00:00, so the estimate is the second midnight). The first second of the day lies within
  // 36 hours of UTC midnight in any zone; find it by halving.
  let lo = Math.floor(midnight / 1000) - 36 * 3600;
  let hi = Math.floor(midnight / 1000) + 36 * 3600;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (isDate(mid * 1000)) hi = mid;
    else lo = mid;
  }
  return new Date(hi * 1000);
}

/** A page: the local day of the instant just before `end` and the 13 days before it. */
export function activityWindow(end: Date, tz: string): { from: Date; to: Date } {
  const lastDay = localDate(new Date(end.getTime() - 1), tz);
  return { from: dayStart(addDays(lastDay, -(ACTIVITY_DAYS - 1)), tz), to: end };
}

// ---------- Merging ----------

/** The row of a report says what its last change was, as far as the row tells (reports keep no history). */
export type ReportChange = {
  status: 'new' | 'triaged' | 'done';
  hasTriage: boolean;
  editedBy: string;
  updatedAt: Date;
  closedAt: Date | null;
  /** Who uploaded a recording or photo at the moment of updated_at, if anyone did. */
  uploadBy: string | null;
};

export function reportUpdate(r: ReportChange): { action: string; by: string } {
  if (r.uploadBy) return { action: 'Updated', by: r.uploadBy };
  if (r.status === 'done' && r.closedAt && Math.abs(r.updatedAt.getTime() - r.closedAt.getTime()) <= SAME_WRITE_MS) {
    return { action: 'Closed', by: r.editedBy };
  }
  if (r.editedBy !== HUMAN && r.hasTriage) return { action: 'Triage written', by: r.editedBy };
  if (r.editedBy === HUMAN) return { action: 'Edited', by: HUMAN };
  return { action: 'Updated', by: r.editedBy };
}

/** Events grouped by a key, each group oldest first. */
function groupBy(events: ActivityEvent[], key: (e: ActivityEvent) => unknown[]): ActivityEvent[][] {
  const groups = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    const k = JSON.stringify(key(e));
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }
  return [...groups.values()].map((list) => list.sort((a, b) => a.at.getTime() - b.at.getTime()));
}

function fileRow(batch: ActivityEvent[]): ActivityItem {
  // Newest first; a file changed twice in the batch counts once.
  const files: ActivityEvent[] = [];
  for (const e of [...batch].reverse()) if (!files.some((f) => f.recordId === e.recordId)) files.push(e);
  const newest = files[0]!;
  const last = batch[batch.length - 1]!;
  const n = files.length;
  const row: ActivityItem = {
    type: 'file',
    action: `${last.by === 'cli' ? 'Pushed' : 'Edited'} ${n} ${n === 1 ? 'file' : 'files'}`,
    ref: refOf(newest.recordId),
    id: newest.recordId,
    title: n === 1 ? newest.path! : `${newest.path} and ${n - 1} more`,
    project: newest.project,
    by: last.by,
    at: last.at.toISOString(),
  };
  if (n === 1) return { ...row, path: newest.path };
  return { ...row, count: n, children: files.map((f) => ({ id: f.recordId, path: f.path!, ref: refOf(f.recordId) })) };
}

/** File versions of one project and author whose neighbours are at most 5 minutes apart make one row. */
function fileRows(events: ActivityEvent[]): ActivityItem[] {
  const rows: ActivityItem[] = [];
  for (const list of groupBy(events, (e) => [e.project, e.by])) {
    let batch: ActivityEvent[] = [];
    for (const e of list) {
      const prev = batch[batch.length - 1];
      if (prev && e.at.getTime() - prev.at.getTime() > FILE_BATCH_GAP_MS) {
        rows.push(fileRow(batch));
        batch = [];
      }
      batch.push(e);
    }
    if (batch.length) rows.push(fileRow(batch));
  }
  return rows;
}

function recordRow(group: ActivityEvent[]): ActivityItem {
  const last = group[group.length - 1]!;
  const action = (group.find((e) => e.create) ?? last).action;
  const base = { action, title: last.title, project: last.project, by: last.by, at: last.at.toISOString() };
  if (last.kind === 'transcript') {
    return { type: 'report', ...base, ref: refOf(last.recordId), id: last.reportId!, attachment_id: last.recordId };
  }
  return { type: last.kind as 'report' | 'thought' | 'note', ...base, ref: refOf(last.recordId), id: last.recordId };
}

/** Changes of one record by one author within an hour of the group's first change make one row. */
function recordRows(events: ActivityEvent[]): ActivityItem[] {
  const rows: ActivityItem[] = [];
  for (const list of groupBy(events, (e) => [e.kind, e.recordId, e.by])) {
    let group: ActivityEvent[] = [];
    for (const e of list) {
      if (group.length && e.at.getTime() - group[0]!.at.getTime() > RECORD_MERGE_MS) {
        rows.push(recordRow(group));
        group = [];
      }
      group.push(e);
    }
    if (group.length) rows.push(recordRow(group));
  }
  return rows;
}

/** The timeline's rows, newest first. */
export function mergeActivity(events: ActivityEvent[]): ActivityItem[] {
  const rows = [...fileRows(events.filter((e) => e.kind === 'file')), ...recordRows(events.filter((e) => e.kind !== 'file'))];
  return rows.sort((a, b) => b.at.localeCompare(a.at) || a.ref.localeCompare(b.ref));
}

/** Rows (newest first) by their local day. */
export function groupByDay(items: ActivityItem[], tz: string): ActivityDay[] {
  const days: ActivityDay[] = [];
  for (const item of items) {
    const date = localDate(new Date(item.at), tz);
    const day = days[days.length - 1];
    if (day?.date === date) day.items.push(item);
    else days.push({ date, items: [item] });
  }
  return days;
}

// ---------- Sources ----------

/** Every change in [from, to) of the asked type. Deleted files and archived thoughts are left out with all their versions. */
async function collect(db: Db, from: Date, to: Date, type: ActivityType | undefined): Promise<ActivityEvent[]> {
  const want = (t: ActivityType) => !type || type === t;
  const inWindow = (c: AnyPgColumn) => and(gte(c, from), lt(c, to));
  const none: Promise<never[]> = Promise.resolve([]);
  const [files, fileRevisions, reportRows, transcripts, thoughtRows, thoughtVersions, noteRows] = await Promise.all([
    want('files')
      ? db
          .select({
            id: projectFiles.id, project: projectFiles.projectId, path: projectFiles.path, by: projectFiles.updatedBy, at: projectFiles.updatedAt,
            version: projectFiles.version,
          })
          .from(projectFiles)
          .where(and(isNull(projectFiles.deletedAt), inWindow(projectFiles.updatedAt)))
      : none,
    want('files')
      ? db
          .select({
            id: projectFiles.id, project: projectFiles.projectId, path: projectFiles.path, by: projectFileRevisions.updatedBy,
            at: projectFileRevisions.createdAt, version: projectFileRevisions.version,
          })
          .from(projectFileRevisions)
          .innerJoin(projectFiles, eq(projectFiles.id, projectFileRevisions.fileId))
          .where(and(isNull(projectFiles.deletedAt), inWindow(projectFileRevisions.createdAt)))
      : none,
    want('reports')
      ? db
          .select({
            id: reports.id, projectId: reports.projectId, title: reports.title, status: reports.status, source: reports.source,
            editedBy: reports.editedBy, version: reports.version, createdAt: reports.createdAt, updatedAt: reports.updatedAt,
            closedAt: reports.closedAt,
            hasTriage: sql<boolean>`${reports.triage} <> ''`,
            // An upload sets updated_at (not edited_by): its author made that change. The outer columns are written
            // with their table: drizzle leaves a one-table select list unqualified, and a bare "id" would be a.id here.
            uploadBy: sql<string | null>`(SELECT a.created_by FROM report_attachments a WHERE a.report_id = reports.id AND a.kind <> 'frame'
              AND a.created_at BETWEEN reports.updated_at - interval '2 seconds' AND reports.updated_at + interval '2 seconds'
              ORDER BY a.created_at DESC LIMIT 1)`,
          })
          .from(reports)
          .where(or(inWindow(reports.createdAt), inWindow(reports.updatedAt)))
      : none,
    want('reports')
      ? db
          .select({
            attachmentId: reportTranscripts.attachmentId, at: reportTranscripts.createdAt, reportId: reports.id, title: reports.title,
            project: reports.projectId,
          })
          .from(reportTranscripts)
          .innerJoin(reportAttachments, eq(reportAttachments.id, reportTranscripts.attachmentId))
          .innerJoin(reports, eq(reports.id, reportAttachments.reportId))
          .where(inWindow(reportTranscripts.createdAt))
      : none,
    want('thoughts')
      ? db
          .select({ id: thoughts.id, title: thoughts.title, by: thoughts.editedBy, at: thoughts.updatedAt, version: thoughts.version })
          .from(thoughts)
          .where(and(eq(thoughts.archived, false), inWindow(thoughts.updatedAt)))
      : none,
    want('thoughts')
      ? db
          .select({ id: thoughts.id, title: thoughts.title, by: thoughtRevisions.editedBy, at: thoughtRevisions.createdAt, version: thoughtRevisions.version })
          .from(thoughtRevisions)
          .innerJoin(thoughts, eq(thoughts.id, thoughtRevisions.thoughtId))
          .where(and(eq(thoughts.archived, false), inWindow(thoughtRevisions.createdAt)))
      : none,
    want('notes')
      ? db
          .select({ id: notes.id, title: notes.title, project: notes.projectId, createdAt: notes.createdAt, updatedAt: notes.updatedAt })
          .from(notes)
          .where(or(inWindow(notes.createdAt), inWindow(notes.updatedAt)))
      : none,
  ]);

  const inside = (d: Date) => d.getTime() >= from.getTime() && d.getTime() < to.getTime();
  const events: ActivityEvent[] = [];
  for (const f of [...files, ...fileRevisions]) {
    events.push({ kind: 'file', recordId: f.id, title: f.path, path: f.path, project: f.project, by: f.by, at: f.at, create: f.version === 1, action: '' });
  }
  for (const r of reportRows) {
    if (inside(r.createdAt)) {
      // The creator's label survives only while nobody has changed the report.
      const by = r.source === 'human' ? HUMAN : r.version === 1 ? r.editedBy : 'agent';
      events.push({ kind: 'report', recordId: r.id, title: r.title, project: r.projectId, by, at: r.createdAt, create: true, action: 'New report' });
    }
    if (r.updatedAt.getTime() > r.createdAt.getTime() && inside(r.updatedAt)) {
      const { action, by } = reportUpdate(r);
      events.push({ kind: 'report', recordId: r.id, title: r.title, project: r.projectId, by, at: r.updatedAt, create: false, action });
    }
  }
  for (const t of transcripts) {
    events.push({
      kind: 'transcript', recordId: t.attachmentId, reportId: t.reportId, title: t.title, project: t.project, by: WORKER, at: t.at, create: false,
      action: 'Transcribed',
    });
  }
  for (const t of [...thoughtRows, ...thoughtVersions]) {
    const first = t.version === 1;
    events.push({ kind: 'thought', recordId: t.id, title: t.title, project: null, by: t.by, at: t.at, create: first, action: first ? 'Saved thought' : 'Edited thought' });
  }
  // Notes have no author column: only the UI writes them.
  for (const n of noteRows) {
    if (inside(n.createdAt)) {
      events.push({ kind: 'note', recordId: n.id, title: n.title, project: n.project, by: HUMAN, at: n.createdAt, create: true, action: 'New note' });
    }
    if (n.updatedAt.getTime() > n.createdAt.getTime() && inside(n.updatedAt)) {
      events.push({ kind: 'note', recordId: n.id, title: n.title, project: n.project, by: HUMAN, at: n.updatedAt, create: false, action: 'Edited note' });
    }
  }
  return events;
}

/** Whether anything of the asked type happened before `before` (then the page has a next_before). One statement, one connection. */
async function hasOlder(db: Db, before: Date, type: ActivityType | undefined): Promise<boolean> {
  const want = (t: ActivityType) => !type || type === t;
  const exists: SQL[] = [];
  const add = (q: SQL | { getSQL(): SQL }) => exists.push(sql`exists (${q})`);
  if (want('files')) {
    add(db.select({ id: projectFiles.id }).from(projectFiles).where(and(isNull(projectFiles.deletedAt), lt(projectFiles.updatedAt, before))).limit(1));
    add(
      db
        .select({ id: projectFileRevisions.id })
        .from(projectFileRevisions)
        .innerJoin(projectFiles, eq(projectFiles.id, projectFileRevisions.fileId))
        .where(and(isNull(projectFiles.deletedAt), lt(projectFileRevisions.createdAt, before)))
        .limit(1),
    );
  }
  if (want('reports')) add(db.select({ id: reports.id }).from(reports).where(lt(reports.createdAt, before)).limit(1));
  if (want('thoughts')) {
    // The versions, not created_at: the oldest versions of a much-edited thought are no longer kept.
    add(db.select({ id: thoughts.id }).from(thoughts).where(and(eq(thoughts.archived, false), lt(thoughts.updatedAt, before))).limit(1));
    add(
      db
        .select({ id: thoughtRevisions.id })
        .from(thoughtRevisions)
        .innerJoin(thoughts, eq(thoughts.id, thoughtRevisions.thoughtId))
        .where(and(eq(thoughts.archived, false), lt(thoughtRevisions.createdAt, before)))
        .limit(1),
    );
  }
  if (want('notes')) add(db.select({ id: notes.id }).from(notes).where(lt(notes.createdAt, before)).limit(1));
  if (!exists.length) return false;
  const rows = await db.execute<{ older: boolean }>(sql`select ${sql.join(exists, sql` or `)} as older`);
  return rows[0]!.older;
}

/** One page of the timeline: 14 local days before `before` (default now), grouped by day, newest first. */
export async function activityPage(
  db: Db,
  opts: { before?: Date; type?: ActivityType; tz: string },
): Promise<ActivityPage> {
  const tz = checkTimeZone(opts.tz);
  const { from, to } = activityWindow(opts.before ?? new Date(), tz);
  const [events, older] = await Promise.all([collect(db, from, to, opts.type), hasOlder(db, from, opts.type)]);
  return { days: groupByDay(mergeActivity(events), tz), next_before: older ? from.toISOString() : null };
}

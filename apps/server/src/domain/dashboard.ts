import { refOf } from '@tabula/shared/refs';
import { and, asc, count, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { messages, projectFiles, reportAttachments, reportJobs, reports, reportTranscripts } from '../db/schema.js';
import { BAR_DAYS, checkTimeZone, projectActivity, SERVER_TZ } from './activity.js';
import type { TrimStep } from './digest.js';
import { FILE_LIMITS } from './files.js';
import { senderView } from './messages.js';
import { listProjects } from './projects.js';
import { recallDigests } from './recall.js';
import { openReportCounts } from './reports.js';
import { DIGEST_BUDGET } from './tokens.js';

/** A project file over this size gets a warning: half of what a file may hold. */
export const LARGE_FILE_BYTES = FILE_LIMITS.contentBytes / 2;
/** Recordings that have waited for transcription longer than this get a warning. */
export const RECORDING_WAIT_MS = 24 * 3600 * 1000;

/** The recordings of a report taken together: one running or waiting wins over a failed one, which wins over done. */
export type WaitingTranscript = 'running' | 'queued' | 'failed' | 'done';

export type WaitingItem = {
  type: 'new_report' | 'triaged' | 'transcription_failed' | 'message_waiting';
  /** The report's or message's id and reference. */
  id: string;
  ref: string;
  title: string;
  project: string | null;
  /** Since when it waits (ISO): created (new), last changed (triaged), when the transcription failed. */
  since: string;
  /** The report's version, for Mark done (expected_version). */
  version: number;
  keep_media: boolean;
  /** Video, audio and documents of the report still on disk: what closing deletes, so the close confirmation names them. */
  media: number;
  transcript: WaitingTranscript | null;
  /** transcription_failed: the recording, its file name and the error. */
  attachment_id?: string;
  file_name?: string;
  error?: string | null;
  /** message_waiting: the project that declares it sent the message, or "author" / "external"; `project` is the recipient. */
  from?: string;
  /** message_waiting without a sender project: the app connection it was sent through. */
  via?: string;
  /** message_waiting from an agent outside any project ("from" is "external"): its own description, not verified. */
  sender?: string;
};

export type DashboardWarning =
  | { type: 'recall_trimmed'; project: string; steps: TrimStep[]; tokens: number }
  | { type: 'large_file'; project: string; id: string; ref: string; path: string; size: number; limit: number }
  | { type: 'recordings_waiting'; project: null; count: number; oldest: string };

export type DashboardProject = {
  id: string;
  name: string;
  last_activity_at: string;
  file_count: number;
  open_reports: number;
  /** Estimated tokens of the project's recall digest with the state (what the Recall preview shows). */
  recall_tokens: number;
  /** Changes per local day over the last 14 days (file versions, report changes, transcripts), oldest first, today last. */
  activity: number[];
};

export type Dashboard = {
  waiting: WaitingItem[];
  warnings: DashboardWarning[];
  projects: DashboardProject[];
  recall_budget: number;
  /** False on a server without Fornax (no TABULA_FORNAX_URL): recordings are queued but nothing will transcribe them. */
  transcription_enabled: boolean;
};

const OPEN = ['new', 'triaged'] as const;
const RANK: Record<WaitingTranscript, number> = { done: 1, failed: 2, queued: 3, running: 4 };

/** What the Home page shows besides the timeline. */
export async function dashboard(db: Db, now = new Date(), { transcriptionEnabled = true, tz = SERVER_TZ }: { transcriptionEnabled?: boolean; tz?: string } = {}): Promise<Dashboard> {
  const zone = checkTimeZone(tz);
  const [open, recordings, documents, large, projectList, openCounts, activity, waitingMessages] = await Promise.all([
    db
      .select({
        id: reports.id, projectId: reports.projectId, title: reports.title, status: reports.status, version: reports.version,
        keepMedia: reports.keepMedia, createdAt: reports.createdAt, updatedAt: reports.updatedAt,
      })
      .from(reports)
      .where(inArray(reports.status, [...OPEN])),
    // Video and audio of open reports, with their job and whether a transcript exists.
    db
      .select({
        id: reportAttachments.id, reportId: reportAttachments.reportId, fileName: reportAttachments.fileName, purgedAt: reportAttachments.purgedAt,
        job: reportJobs.status, error: reportJobs.error, runAfter: reportJobs.runAfter, finishedAt: reportJobs.finishedAt,
        jobUpdatedAt: reportJobs.updatedAt, transcribed: reportTranscripts.attachmentId,
      })
      .from(reportAttachments)
      .innerJoin(reports, eq(reports.id, reportAttachments.reportId))
      .leftJoin(reportJobs, and(eq(reportJobs.attachmentId, reportAttachments.id), eq(reportJobs.kind, 'transcribe')))
      .leftJoin(reportTranscripts, eq(reportTranscripts.attachmentId, reportAttachments.id))
      .where(and(inArray(reports.status, [...OPEN]), inArray(reportAttachments.kind, ['video', 'audio']))),
    // Documents of open reports still on disk: closing deletes them like video and audio.
    db
      .select({ reportId: reportAttachments.reportId, n: count() })
      .from(reportAttachments)
      .innerJoin(reports, eq(reports.id, reportAttachments.reportId))
      .where(and(inArray(reports.status, [...OPEN]), eq(reportAttachments.kind, 'document'), isNull(reportAttachments.purgedAt)))
      .groupBy(reportAttachments.reportId),
    db
      .select({ id: projectFiles.id, projectId: projectFiles.projectId, path: projectFiles.path, size: projectFiles.size })
      .from(projectFiles)
      // `global` is left out like everywhere on Home: the web has no file view for it.
      .where(and(isNull(projectFiles.deletedAt), ne(projectFiles.projectId, 'global'), gt(projectFiles.size, LARGE_FILE_BYTES)))
      .orderBy(desc(projectFiles.size), asc(projectFiles.projectId), asc(projectFiles.path)),
    listProjects(db),
    openReportCounts(db),
    projectActivity(db, now, zone),
    db
      .select({
        id: messages.id, title: messages.title, toProject: messages.toProject, fromProject: messages.fromProject,
        createdBy: messages.createdBy, source: messages.source, sender: messages.sender, version: messages.version, updatedAt: messages.updatedAt,
      })
      .from(messages)
      .where(and(eq(messages.status, 'waiting'), eq(messages.waitingOn, 'author'))),
  ]);
  const projects = projectList.filter((p) => p.id !== 'global');
  const digests = await recallDigests(db, projects.map((p) => p.id), now);

  type Recording = (typeof recordings)[number];
  const stateOf = (a: Recording): WaitingTranscript | null =>
    // A purged recording is never worked on (the sync skips it, Try again refuses it): its job state means nothing.
    !a.purgedAt && (a.job === 'queued' || a.job === 'running' || a.job === 'failed') ? a.job : a.transcribed ? 'done' : null;
  const recordingsOf = new Map<string, Recording[]>();
  for (const a of recordings) {
    const list = recordingsOf.get(a.reportId);
    if (list) list.push(a);
    else recordingsOf.set(a.reportId, [a]);
  }

  const documentsOf = new Map(documents.map((d) => [d.reportId, d.n]));
  const waiting: WaitingItem[] = [];
  for (const r of open) {
    const recs = recordingsOf.get(r.id) ?? [];
    let transcript: WaitingTranscript | null = null;
    for (const a of recs) {
      const s = stateOf(a);
      if (s && (!transcript || RANK[s] > RANK[transcript])) transcript = s;
    }
    const onDisk = recs.filter((a) => !a.purgedAt).length;
    const base = {
      id: r.id, ref: refOf(r.id), title: r.title, project: r.projectId, version: r.version, keep_media: r.keepMedia,
      media: onDisk + (documentsOf.get(r.id) ?? 0), transcript,
    };
    waiting.push({ ...base, type: r.status === 'new' ? 'new_report' : 'triaged', since: (r.status === 'new' ? r.createdAt : r.updatedAt).toISOString() });
    for (const a of recs) {
      // A deleted recording can't be transcribed again: nothing to offer.
      if (a.job !== 'failed' || a.purgedAt) continue;
      waiting.push({
        ...base, type: 'transcription_failed', since: (a.finishedAt ?? a.jobUpdatedAt ?? r.updatedAt).toISOString(),
        attachment_id: a.id, file_name: a.fileName, error: a.error,
      });
    }
  }
  for (const m of waitingMessages) {
    waiting.push({
      type: 'message_waiting', id: m.id, ref: refOf(m.id), title: m.title, project: m.toProject, ...senderView(m),
      since: m.updatedAt.toISOString(), version: m.version, keep_media: false, media: 0, transcript: null,
    });
  }
  waiting.sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));

  const warnings: DashboardWarning[] = [];
  const cutoff = now.getTime() - RECORDING_WAIT_MS;
  const stuck = recordings.filter((a) => a.job === 'queued' && !a.purgedAt && a.runAfter !== null && a.runAfter.getTime() < cutoff);
  // Without Fornax nothing is expected to transcribe: a waiting recording is no alarm.
  if (transcriptionEnabled && stuck.length) {
    const oldest = Math.min(...stuck.map((a) => a.runAfter!.getTime()));
    warnings.push({ type: 'recordings_waiting', project: null, count: stuck.length, oldest: new Date(oldest).toISOString() });
  }
  for (const p of projects) {
    const d = digests.get(p.id);
    if (d?.trimmed.length) warnings.push({ type: 'recall_trimmed', project: p.id, steps: d.trimmed, tokens: d.tokens });
  }
  for (const f of large) {
    warnings.push({ type: 'large_file', project: f.projectId, id: f.id, ref: refOf(f.id), path: f.path, size: f.size, limit: FILE_LIMITS.contentBytes });
  }

  return {
    waiting,
    warnings,
    projects: projects.map((p) => ({
      id: p.id, name: p.name, last_activity_at: p.last_activity_at, file_count: p.file_count, open_reports: openCounts[p.id] ?? 0,
      recall_tokens: digests.get(p.id)?.tokens ?? 0,
      activity: activity.get(p.id) ?? Array(BAR_DAYS).fill(0),
    })),
    recall_budget: DIGEST_BUDGET,
    transcription_enabled: transcriptionEnabled,
  };
}

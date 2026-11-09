import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { reportAttachments, reports } from '../db/schema.js';
import { downscaleImage, extractFrame, type FfmpegPaths, hasAudioStream, NoFrameError, probeDurationMs, remuxWebm } from '../media/ffmpeg.js';
import type { MediaStore, StoredFile } from '../media/store.js';
import { badRequest, conflict, notFound, unavailable } from './errors.js';
import { enqueueTranscription, failPendingJobs } from './jobs.js';
import { matchesPrefix, type Page, type PageQuery, pageWindow, prefixTsQuery } from './paging.js';
import { dateTitle } from '../shared/report-title.js';
import { requireProject } from './projects.js';
import { charCount, NO_PROJECT, rejectNul } from './validation.js';

export const REPORT_STATUSES = ['new', 'triaged', 'done'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const REPORT_LIMITS = { title: 200, body: 20_000, triage: 50_000, fileName: 200, frameNote: 2000 } as const;

/** Who is writing: the human in the UI, or an agent with its label. */
export type Editor = { source: 'agent' | 'human'; label: string };

const cols = {
  id: reports.id,
  projectId: reports.projectId,
  title: reports.title,
  body: reports.body,
  triage: reports.triage,
  status: reports.status,
  source: reports.source,
  editedBy: reports.editedBy,
  version: reports.version,
  closedAt: reports.closedAt,
  keepMedia: reports.keepMedia,
  createdAt: reports.createdAt,
  updatedAt: reports.updatedAt,
};

export type Report = {
  id: string;
  /** null: the report belongs to no project. */
  projectId: string | null;
  title: string;
  body: string;
  triage: string;
  status: ReportStatus;
  source: 'agent' | 'human';
  editedBy: string;
  version: number;
  closedAt: Date | null;
  /** Video and audio stay after closing. */
  keepMedia: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type Attachment = typeof reportAttachments.$inferSelect;
export type ReportSummary = Report & { counts: Record<'image' | 'video' | 'audio' | 'frame', number> };

function cleanTitle(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  rejectNul(t, 'title');
  const n = charCount(t);
  if (n > REPORT_LIMITS.title) throw badRequest(`title is ${n} characters; the limit is ${REPORT_LIMITS.title}`);
  return t;
}

function checkText(value: string, field: 'body' | 'triage'): string {
  rejectNul(value, field);
  const n = charCount(value);
  if (n > REPORT_LIMITS[field]) throw badRequest(`${field} is ${n} characters; the limit is ${REPORT_LIMITS[field]}`);
  return value;
}

/** A report's project: an existing project, or null for none (null, undefined and '' alike). "global" is refused. */
async function checkProject(db: Db, projectId: string | null | undefined): Promise<string | null> {
  if (!projectId) return null;
  if (projectId === 'global') throw badRequest('a report belongs to a project or to none, not to "global"');
  await requireProject(db, projectId);
  return projectId;
}

/** A title from the first line of the description, so a report can be captured with one tap; else the date and time (server time zone, TZ). */
function defaultTitle(body: string, now: Date): string {
  const first = body.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean);
  if (first) return [...first].slice(0, 120).join('');
  return dateTitle(now);
}

export async function getReport(db: Db, id: string): Promise<Report | undefined> {
  const [row] = await db.select(cols).from(reports).where(eq(reports.id, id));
  return row;
}

export async function requireReport(db: Db, id: string): Promise<Report> {
  const r = await getReport(db, id);
  if (!r) throw notFound(`report ${id} does not exist`);
  return r;
}

export async function createReport(
  db: Db,
  input: { projectId?: string | null; title?: string; body?: string },
  editor: Editor,
  now = new Date(),
): Promise<Report> {
  const projectId = await checkProject(db, input.projectId);
  const body = checkText((input.body ?? '').trim(), 'body');
  const title = cleanTitle(input.title ?? '') || defaultTitle(body, now);
  const [row] = await db
    .insert(reports)
    .values({ projectId, title, body, source: editor.source, editedBy: editor.label })
    .returning(cols);
  return row!;
}

export type ReportPatch = {
  title?: string;
  body?: string;
  triage?: string;
  /** Added to the end of the triage after a blank line. */
  appendTriage?: string;
  status?: ReportStatus;
  /** null (or ''): the report no longer belongs to a project. */
  projectId?: string | null;
  keepMedia?: boolean;
  /** Reject the write if someone else changed the report since this version was read. */
  expectedVersion?: number;
};

export async function updateReport(db: Db, id: string, patch: ReportPatch, editor: Editor): Promise<Report> {
  const newProject = patch.projectId === undefined ? undefined : await checkProject(db, patch.projectId);
  return db.transaction(async (tx) => {
    const [cur] = await tx.select(cols).from(reports).where(eq(reports.id, id)).for('update');
    if (!cur) throw notFound(`report ${id} does not exist`);
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== cur.version) {
      throw conflict(
        `report was changed meanwhile by ${cur.editedBy} (now version ${cur.version}, you edited ${patch.expectedVersion}). Reload it and apply your change again.`,
      );
    }
    const title = patch.title !== undefined ? cleanTitle(patch.title) || cur.title : cur.title;
    const body = patch.body !== undefined ? checkText(patch.body.trim(), 'body') : cur.body;
    let triage = patch.triage !== undefined ? patch.triage.trim() : cur.triage;
    if (patch.appendTriage?.trim()) triage = triage ? `${triage.trimEnd()}\n\n${patch.appendTriage.trim()}` : patch.appendTriage.trim();
    checkText(triage, 'triage');
    const status = patch.status ?? cur.status;
    const projectId = newProject === undefined ? cur.projectId : newProject;
    const keepMedia = patch.keepMedia ?? cur.keepMedia;

    const changed =
      title !== cur.title || body !== cur.body || triage !== cur.triage || status !== cur.status || projectId !== cur.projectId ||
      keepMedia !== cur.keepMedia;
    if (!changed) return cur;
    const closedAt = status === 'done' ? (cur.status === 'done' ? cur.closedAt : new Date()) : null;
    const [row] = await tx
      .update(reports)
      .set({ title, body, triage, status, projectId, keepMedia, closedAt, editedBy: editor.label, version: cur.version + 1 })
      .where(eq(reports.id, id))
      .returning(cols);
    return row!;
  });
}

export async function deleteReport(db: Db, store: MediaStore, id: string): Promise<void> {
  const deleted = await db.delete(reports).where(eq(reports.id, id)).returning({ id: reports.id });
  if (deleted.length === 0) throw notFound(`report ${id} does not exist`);
  await store.removeReport(id);
}

export const REPORT_SORTS = ['createdAt', 'updatedAt', 'title', 'status'] as const;
export type ReportSort = (typeof REPORT_SORTS)[number];
/** "open" = new and triaged: everything not closed yet. */
export type ReportStatusFilter = ReportStatus | 'open' | 'all';

/** A report whose recordings' transcripts match a prefix query. */
const transcriptMatches = (tsq: string) => sql`EXISTS (
  SELECT 1 FROM report_transcripts t JOIN report_attachments a ON a.id = t.attachment_id
  WHERE a.report_id = ${reports.id} AND t.search @@ to_tsquery('tabula', ${tsq}))`;

/** `projectId` "none" (NO_PROJECT) lists the reports without a project; absent lists all. */
export async function pageReports(
  db: Db,
  f: { projectId?: string; status?: ReportStatusFilter; q?: string } & PageQuery<ReportSort>,
): Promise<Page<ReportSummary>> {
  const { page, pageSize, limit, offset } = pageWindow(f);
  const status = f.status ?? 'open';
  const tsq = prefixTsQuery(f.q);
  const where = and(
    f.projectId === NO_PROJECT ? isNull(reports.projectId) : f.projectId ? eq(reports.projectId, f.projectId) : undefined,
    status === 'open' ? inArray(reports.status, ['new', 'triaged']) : status === 'all' ? undefined : eq(reports.status, status),
    tsq ? or(matchesPrefix(reports.search, tsq), transcriptMatches(tsq)) : undefined,
  );
  const order = (f.dir ?? 'desc') === 'asc' ? asc : desc;
  const [items, [total]] = await Promise.all([
    db.select(cols).from(reports).where(where)
      .orderBy(order(reports[f.sort ?? 'createdAt']), desc(reports.createdAt), asc(reports.id))
      .limit(limit).offset(offset),
    db.select({ n: count() }).from(reports).where(where),
  ]);
  const ids = items.map((r) => r.id);
  const counts = ids.length
    ? await db
        .select({ reportId: reportAttachments.reportId, kind: reportAttachments.kind, n: count() })
        .from(reportAttachments)
        .where(inArray(reportAttachments.reportId, ids))
        .groupBy(reportAttachments.reportId, reportAttachments.kind)
    : [];
  return {
    items: items.map((r) => {
      const c = { image: 0, video: 0, audio: 0, frame: 0 };
      for (const x of counts) if (x.reportId === r.id) c[x.kind] = x.n;
      return { ...r, counts: c };
    }),
    total: total?.n ?? 0,
    page,
    pageSize,
  };
}

/** Open reports per project, for the sidebar; reports without a project count under "none". */
export async function openReportCounts(db: Db): Promise<Record<string, number>> {
  const rows = await db
    .select({ projectId: reports.projectId, n: count() })
    .from(reports)
    .where(inArray(reports.status, ['new', 'triaged']))
    .groupBy(reports.projectId);
  return Object.fromEntries(rows.map((r) => [r.projectId ?? NO_PROJECT, r.n]));
}

export async function listAttachments(db: Db, reportId: string): Promise<Attachment[]> {
  return db.select().from(reportAttachments).where(eq(reportAttachments.reportId, reportId)).orderBy(asc(reportAttachments.createdAt));
}

export async function getAttachment(db: Db, id: string): Promise<Attachment | undefined> {
  const [row] = await db.select().from(reportAttachments).where(eq(reportAttachments.id, id));
  return row;
}

export async function requireAttachment(db: Db, id: string): Promise<Attachment> {
  const a = await getAttachment(db, id);
  if (!a) throw notFound(`attachment ${id} does not exist`);
  return a;
}

const safeFileName = (raw: string | undefined, ext: string): string => {
  const base = (raw ?? '').replace(/[\x00-\x1f\x7f/\\]/g, '').trim();
  const name = [...base].slice(0, REPORT_LIMITS.fileName).join('');
  return name || `attachment.${ext}`;
};

export const CLOSED_REPORT = 'the report is closed; reopen it before adding files';

/**
 * A WebM rewritten by ffmpeg with its duration and seek index; the original when ffmpeg can't (or isn't installed).
 * The original temporary file is replaced on success.
 */
async function remuxed(store: MediaStore, paths: FfmpegPaths, file: StoredFile): Promise<StoredFile> {
  const out = store.tempPath();
  try {
    await remuxWebm(paths, file.tmpPath, file.type.mime, out);
    const { size, sha256 } = await store.digest(out);
    await store.discard(file.tmpPath);
    return { ...file, tmpPath: out, size, sha256 };
  } catch {
    await store.discard(out);
    return file;
  }
}

/** After a failed insert: a report deleted meanwhile must not keep a directory that the upload recreated. */
async function cleanupDeletedReport(db: Db, store: MediaStore, reportId: string): Promise<void> {
  if (!(await getReport(db, reportId))) await store.removeReport(reportId).catch(() => {});
}

/** Store an uploaded file (already streamed to a temporary file by MediaStore.receive) as an attachment. */
export async function addAttachment(
  db: Db,
  store: MediaStore,
  paths: FfmpegPaths,
  reportId: string,
  upload: StoredFile,
  fileName: string | undefined,
  editor: Editor,
): Promise<Attachment> {
  let file = upload;
  try {
    const report = await requireReport(db, reportId);
    if (report.status === 'done') throw conflict(CLOSED_REPORT);
    const id = randomUUID();
    const key = `${reportId}/${id}.${file.type.ext}`;
    let durationMs: number | null = null;
    let transcribe = false;
    if (file.type.kind !== 'image') {
      if (file.type.ext === 'webm') file = await remuxed(store, paths, file);
      durationMs = await probeDurationMs(paths, file.tmpPath, file.type.mime);
      // A video without a sound track has nothing to transcribe; when ffprobe can't tell, the worker finds out.
      transcribe = file.type.kind === 'audio' || (await hasAudioStream(paths, file.tmpPath, file.type.mime)) !== false;
    }
    await store.commit(file.tmpPath, key);
    let row: Attachment;
    try {
      const [inserted] = await db
        .insert(reportAttachments)
        .values({
          id, reportId, kind: file.type.kind, mime: file.type.mime, size: file.size, sha256: file.sha256,
          fileName: safeFileName(fileName, file.type.ext), storageKey: key, durationMs, createdBy: editor.label,
        })
        .returning();
      row = inserted!;
      await db.update(reports).set({ updatedAt: new Date() }).where(eq(reports.id, reportId));
    } catch (e) {
      await store.remove(key);
      await cleanupDeletedReport(db, store, reportId);
      throw e;
    }
    // After the row is safe: a failure here must not delete the stored file.
    if (transcribe) await enqueueTranscription(db, row.id);
    return row;
  } catch (e) {
    await store.discard(file.tmpPath);
    throw e;
  }
}

/** The note on a saved frame: trimmed, blank or null clears it. Allowed on closed reports too. */
export async function setFrameNote(db: Db, id: string, raw: string | null): Promise<Attachment> {
  const a = await requireAttachment(db, id);
  if (a.kind !== 'frame') throw badRequest('only a saved frame takes a note');
  const note = raw === null ? '' : raw.trim();
  rejectNul(note, 'note');
  const n = charCount(note);
  if (n > REPORT_LIMITS.frameNote) throw badRequest(`note is ${n} characters; the limit is ${REPORT_LIMITS.frameNote}`);
  const [row] = await db.update(reportAttachments).set({ note: note || null }).where(eq(reportAttachments.id, id)).returning();
  if (!row) throw notFound(`attachment ${id} does not exist`);
  return row;
}

export async function deleteAttachment(db: Db, store: MediaStore, id: string): Promise<void> {
  const [row] = await db.delete(reportAttachments).where(eq(reportAttachments.id, id)).returning();
  if (!row) throw notFound(`attachment ${id} does not exist`);
  await store.remove(row.storageKey);
}

/** No recording is longer; also keeps the moment within the database's integer column. */
export const MAX_TIMESTAMP_MS = 24 * 3600 * 1000;

/** "2:41", "1:02:03", "161" or "161.5" (seconds) → milliseconds. */
export function parseTimestamp(raw: string | number): number {
  let ms: number;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) throw badRequest('at must be a non-negative number of seconds');
    ms = Math.round(raw * 1000);
  } else {
    const m = /^\s*(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(raw);
    if (!m) throw badRequest(`at "${raw}" must be seconds (161.5) or mm:ss / hh:mm:ss (2:41)`);
    const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number);
    ms = Math.round(parts.reduce((acc, p) => acc * 60 + p, 0) * 1000);
  }
  if (ms > MAX_TIMESTAMP_MS) throw badRequest(`at ${raw} is past 24:00:00; no recording is that long`);
  return ms;
}

/**
 * A still from a video at a moment, stored as a "frame" attachment so it stays after the video is deleted.
 * The same moment of the same video is extracted only once.
 */
export async function frameAt(
  db: Db,
  store: MediaStore,
  paths: FfmpegPaths,
  videoId: string,
  atMs: number,
  editor: Editor,
): Promise<{ frame: Attachment; image: Buffer; created: boolean }> {
  const video = await requireAttachment(db, videoId);
  if (video.kind !== 'video') throw badRequest(`attachment ${videoId} is ${video.kind === 'frame' ? 'a frame' : `an ${video.kind}`}, not a video`);
  if (video.purgedAt) throw conflict('the video was deleted after the report was closed; only its saved frames remain');
  if (video.durationMs !== null && atMs > video.durationMs) {
    throw badRequest(`the video is ${(video.durationMs / 1000).toFixed(1)} s long; ${(atMs / 1000).toFixed(1)} s is past its end`);
  }
  const [existing] = await db
    .select()
    .from(reportAttachments)
    .where(and(eq(reportAttachments.sourceId, videoId), eq(reportAttachments.atMs, atMs), eq(reportAttachments.kind, 'frame')));
  if (existing) {
    return { frame: existing, image: await readAll(store, existing.storageKey), created: false };
  }
  await store.ensureWritable();
  let image: Buffer;
  try {
    image = await extractFrame(paths, store.path(video.storageKey), video.mime, atMs);
  } catch (e) {
    const at = `could not take a frame at ${(atMs / 1000).toFixed(1)} s`;
    if (e instanceof NoFrameError) throw badRequest(`${at}: ${e.message}`);
    // ffmpeg's own message names server paths: it goes to the log only.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw Object.assign(unavailable(`${at}: ffmpeg is not installed on the server`), { cause: e });
    throw Object.assign(badRequest(`${at}: the video could not be decoded there`), { cause: e });
  }
  const id = randomUUID();
  const key = `${video.reportId}/${id}.jpg`;
  await store.writeBuffer(key, image);
  const secs = Math.floor(atMs / 1000);
  const label = `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;
  let frame: Attachment | undefined;
  try {
    [frame] = await db
      .insert(reportAttachments)
      .values({
        id, reportId: video.reportId, kind: 'frame', mime: 'image/jpeg', size: image.length,
        sha256: createHash('sha256').update(image).digest('hex'),
        fileName: `${video.fileName.replace(/\.[^.]+$/, '')}-${label}.jpg`, storageKey: key, sourceId: videoId, atMs,
        createdBy: editor.label,
      })
      // The same moment asked for twice at once: the first one wins.
      .onConflictDoNothing({ target: [reportAttachments.sourceId, reportAttachments.atMs] })
      .returning();
  } catch (e) {
    await store.remove(key);
    await cleanupDeletedReport(db, store, video.reportId);
    throw e;
  }
  if (frame) return { frame, image, created: true };
  await store.remove(key);
  const [saved] = await db
    .select()
    .from(reportAttachments)
    .where(and(eq(reportAttachments.sourceId, videoId), eq(reportAttachments.atMs, atMs), eq(reportAttachments.kind, 'frame')));
  if (!saved) throw conflict('the frame was deleted meanwhile; ask again');
  return { frame: saved, image: await readAll(store, saved.storageKey), created: false };
}

async function readAll(store: MediaStore, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of store.open(key)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** An image attachment or a frame as a JPEG small enough for an agent. */
export async function attachmentImage(db: Db, store: MediaStore, paths: FfmpegPaths, id: string): Promise<{ attachment: Attachment; image: Buffer; mime: string }> {
  const a = await requireAttachment(db, id);
  if (a.kind === 'frame') return { attachment: a, image: await readAll(store, a.storageKey), mime: 'image/jpeg' };
  if (a.kind !== 'image') {
    throw badRequest(`attachment ${id} is ${a.kind === 'audio' ? 'an audio recording' : 'a video'}; use get_frame for a still from a video`);
  }
  try {
    return { attachment: a, image: await downscaleImage(paths, store.path(a.storageKey), a.mime), mime: 'image/jpeg' };
  } catch {
    // Without ffmpeg (or for a format it can't read) the original is sent if it is small enough.
    if (a.size <= 4 * 1024 * 1024 && a.mime !== 'image/heic') return { attachment: a, image: await readAll(store, a.storageKey), mime: a.mime };
    throw badRequest(`attachment ${id} could not be converted for viewing; open its url instead`);
  }
}

/**
 * Video and audio of reports closed more than `hours` ago are deleted from disk, unless the report has Keep media on
 * (checked on every run, so turning it off lets the next run delete them); photos, frames and the text stay.
 * The rows remain with purged_at set, so the report still shows what was there. A file that can't be deleted is
 * reported to onError and tried again next time; the others go on. Returns how many were deleted.
 */
export async function purgeClosedMedia(
  db: Db,
  store: MediaStore,
  hours: number,
  now = new Date(),
  onError: (err: unknown, attachmentId: string) => void = () => {},
): Promise<number> {
  const cutoff = new Date(now.getTime() - hours * 3600 * 1000);
  const dueReport = and(eq(reports.status, 'done'), eq(reports.keepMedia, false), lt(reports.closedAt, cutoff));
  const due = await db
    .select({ id: reportAttachments.id, key: reportAttachments.storageKey, reportId: reportAttachments.reportId })
    .from(reportAttachments)
    .innerJoin(reports, eq(reports.id, reportAttachments.reportId))
    .where(
      and(
        inArray(reportAttachments.kind, ['video', 'audio']),
        isNull(reportAttachments.purgedAt),
        dueReport,
      ),
    );
  let deleted = 0;
  for (const a of due) {
    try {
      // The selection may be stale (Keep media turned on, or the report reopened, since): the report is checked again
      // under a share lock, so updateReport waits until the file is gone and the row says so.
      const purged = await db.transaction(async (tx) => {
        const [still] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.id, a.reportId), dueReport)).for('share');
        if (!still) return false;
        await store.remove(a.key);
        // Job rows first, then the attachment row: completeJob locks them in that order too.
        await failPendingJobs(tx, [a.id], now);
        await tx.update(reportAttachments).set({ purgedAt: now }).where(eq(reportAttachments.id, a.id));
        return true;
      });
      if (purged) deleted++;
    } catch (e) {
      onError(e, a.id);
    }
  }
  return deleted;
}


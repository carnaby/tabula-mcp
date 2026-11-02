import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { reportAttachments, reports } from '../db/schema.js';
import { downscaleImage, extractFrame, type FfmpegPaths, probeDurationMs } from '../media/ffmpeg.js';
import type { MediaStore, StoredFile } from '../media/store.js';
import { badRequest, conflict, notFound } from './errors.js';
import { matchesPrefix, type Page, type PageQuery, pageWindow, prefixTsQuery } from './paging.js';
import { requireProject } from './projects.js';
import { charCount, rejectNul } from './validation.js';

export const REPORT_STATUSES = ['new', 'triaged', 'done'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const REPORT_LIMITS = { title: 200, body: 20_000, triage: 50_000, fileName: 200 } as const;

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
  createdAt: reports.createdAt,
  updatedAt: reports.updatedAt,
};

export type Report = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  triage: string;
  status: ReportStatus;
  source: 'agent' | 'human';
  editedBy: string;
  version: number;
  closedAt: Date | null;
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

/** A title from the first line of the description, so a report can be captured with one tap. */
function defaultTitle(body: string, now: Date): string {
  const first = body.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean);
  if (first) return [...first].slice(0, 120).join('');
  return `Bug report ${now.toISOString().slice(0, 16).replace('T', ' ')}`;
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
  input: { projectId: string; title?: string; body?: string },
  editor: Editor,
  now = new Date(),
): Promise<Report> {
  if (input.projectId === 'global') throw badRequest('a report belongs to a project, not to "global"');
  await requireProject(db, input.projectId);
  const body = checkText((input.body ?? '').trim(), 'body');
  const title = cleanTitle(input.title ?? '') || defaultTitle(body, now);
  const [row] = await db
    .insert(reports)
    .values({ projectId: input.projectId, title, body, source: editor.source, editedBy: editor.label })
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
  projectId?: string;
  /** Reject the write if someone else changed the report since this version was read. */
  expectedVersion?: number;
};

export async function updateReport(db: Db, id: string, patch: ReportPatch, editor: Editor): Promise<Report> {
  if (patch.projectId !== undefined) {
    if (patch.projectId === 'global') throw badRequest('a report belongs to a project, not to "global"');
    await requireProject(db, patch.projectId);
  }
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
    const projectId = patch.projectId ?? cur.projectId;

    const changed =
      title !== cur.title || body !== cur.body || triage !== cur.triage || status !== cur.status || projectId !== cur.projectId;
    if (!changed) return cur;
    const closedAt = status === 'done' ? (cur.status === 'done' ? cur.closedAt : new Date()) : null;
    const [row] = await tx
      .update(reports)
      .set({ title, body, triage, status, projectId, closedAt, editedBy: editor.label, version: cur.version + 1 })
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

export async function pageReports(
  db: Db,
  f: { projectId?: string; status?: ReportStatusFilter; q?: string } & PageQuery<ReportSort>,
): Promise<Page<ReportSummary>> {
  const { page, pageSize, limit, offset } = pageWindow(f);
  const status = f.status ?? 'open';
  const tsq = prefixTsQuery(f.q);
  const where = and(
    f.projectId ? eq(reports.projectId, f.projectId) : undefined,
    status === 'open' ? inArray(reports.status, ['new', 'triaged']) : status === 'all' ? undefined : eq(reports.status, status),
    tsq ? matchesPrefix(reports.search, tsq) : undefined,
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

/** Open reports per project, for the sidebar. */
export async function openReportCounts(db: Db): Promise<Record<string, number>> {
  const rows = await db
    .select({ projectId: reports.projectId, n: count() })
    .from(reports)
    .where(inArray(reports.status, ['new', 'triaged']))
    .groupBy(reports.projectId);
  return Object.fromEntries(rows.map((r) => [r.projectId, r.n]));
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

/** Store an uploaded file (already streamed to a temporary file by MediaStore.receive) as an attachment. */
export async function addAttachment(
  db: Db,
  store: MediaStore,
  paths: FfmpegPaths,
  reportId: string,
  file: StoredFile,
  fileName: string | undefined,
  editor: Editor,
): Promise<Attachment> {
  try {
    const report = await requireReport(db, reportId);
    if (report.status === 'done') throw conflict('the report is closed; reopen it before adding files');
    const id = randomUUID();
    const key = `${reportId}/${id}.${file.type.ext}`;
    const durationMs = file.type.kind === 'image' ? null : await probeDurationMs(paths, file.tmpPath);
    await store.commit(file.tmpPath, key);
    try {
      const [row] = await db
        .insert(reportAttachments)
        .values({
          id, reportId, kind: file.type.kind, mime: file.type.mime, size: file.size, sha256: file.sha256,
          fileName: safeFileName(fileName, file.type.ext), storageKey: key, durationMs, createdBy: editor.label,
        })
        .returning();
      await db.update(reports).set({ updatedAt: new Date() }).where(eq(reports.id, reportId));
      return row!;
    } catch (e) {
      await store.remove(key);
      throw e;
    }
  } catch (e) {
    await store.discard(file.tmpPath);
    throw e;
  }
}

export async function deleteAttachment(db: Db, store: MediaStore, id: string): Promise<void> {
  const [row] = await db.delete(reportAttachments).where(eq(reportAttachments.id, id)).returning();
  if (!row) throw notFound(`attachment ${id} does not exist`);
  await store.remove(row.storageKey);
}

/** "2:41", "1:02:03", "161" or "161.5" (seconds) → milliseconds. */
export function parseTimestamp(raw: string | number): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) throw badRequest('at must be a non-negative number of seconds');
    return Math.round(raw * 1000);
  }
  const m = /^\s*(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (!m) throw badRequest(`at "${raw}" must be seconds (161.5) or mm:ss / hh:mm:ss (2:41)`);
  const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number);
  const secs = parts.reduce((acc, p) => acc * 60 + p, 0);
  return Math.round(secs * 1000);
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
  let image: Buffer;
  try {
    image = await extractFrame(paths, store.path(video.storageKey), atMs);
  } catch (e) {
    throw badRequest(`could not take a frame at ${(atMs / 1000).toFixed(1)} s: ${(e as Error).message}`);
  }
  const id = randomUUID();
  const key = `${video.reportId}/${id}.jpg`;
  await store.writeBuffer(key, image);
  const secs = Math.floor(atMs / 1000);
  const label = `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;
  const [frame] = await db
    .insert(reportAttachments)
    .values({
      id, reportId: video.reportId, kind: 'frame', mime: 'image/jpeg', size: image.length,
      sha256: createHash('sha256').update(image).digest('hex'),
      fileName: `${video.fileName.replace(/\.[^.]+$/, '')}-${label}.jpg`, storageKey: key, sourceId: videoId, atMs,
      createdBy: editor.label,
    })
    .returning();
  return { frame: frame!, image, created: true };
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
    return { attachment: a, image: await downscaleImage(paths, store.path(a.storageKey)), mime: 'image/jpeg' };
  } catch {
    // Without ffmpeg (or for a format it can't read) the original is sent if it is small enough.
    if (a.size <= 4 * 1024 * 1024 && a.mime !== 'image/heic') return { attachment: a, image: await readAll(store, a.storageKey), mime: a.mime };
    throw badRequest(`attachment ${id} could not be converted for viewing; open its url instead`);
  }
}

/**
 * Video and audio of reports closed more than `hours` ago are deleted from disk; photos, frames and the text stay.
 * The rows remain with purged_at set, so the report still shows what was there.
 */
export async function purgeClosedMedia(db: Db, store: MediaStore, hours: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - hours * 3600 * 1000);
  const due = await db
    .select({ id: reportAttachments.id, key: reportAttachments.storageKey })
    .from(reportAttachments)
    .innerJoin(reports, eq(reports.id, reportAttachments.reportId))
    .where(
      and(
        inArray(reportAttachments.kind, ['video', 'audio']),
        isNull(reportAttachments.purgedAt),
        eq(reports.status, 'done'),
        lt(reports.closedAt, cutoff),
      ),
    );
  for (const a of due) {
    await store.remove(a.key);
    await db.update(reportAttachments).set({ purgedAt: now }).where(eq(reportAttachments.id, a.id));
  }
  return due.length;
}


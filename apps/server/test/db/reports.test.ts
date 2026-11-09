import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { reportAttachments, reports } from '../../src/db/schema.js';
import { createReport, openReportCounts, pageReports, purgeClosedMedia, updateReport } from '../../src/domain/reports.js';
import { dateTitle } from '@tabula/shared/report-title';
import { MediaStore } from '../../src/media/store.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const HUMAN = { source: 'human' as const, label: 'human' };
beforeEach(() => seedProject(db, 'demo'));

describe('reports without a project', () => {
  it('creates a report with no fields at all, titled with the date and time', async () => {
    // Local time: the title follows the server's time zone (TZ).
    const now = new Date(2026, 10, 9, 14, 32);
    expect(await createReport(db, {}, HUMAN, now)).toMatchObject({ projectId: null, title: 'Report 9. 11. 2026 14:32', body: '', keepMedia: false });
    expect(dateTitle(new Date(2026, 0, 5, 7, 4))).toBe('Report 5. 1. 2026 07:04');
    expect((await createReport(db, { body: '\n# Meeting with Eva\nnotes' }, HUMAN, now)).title).toBe('Meeting with Eva');
    expect((await createReport(db, { projectId: '' }, HUMAN, now)).projectId).toBeNull();
    expect((await createReport(db, { projectId: 'demo' }, HUMAN, now)).projectId).toBe('demo');
    await expect(createReport(db, { projectId: 'global' }, HUMAN)).rejects.toThrow(/not to "global"/);
    await expect(createReport(db, { projectId: 'nope' }, HUMAN)).rejects.toThrow(/project "nope" does not exist/);
  });

  it('assigns, changes and removes the project, and turns Keep media on', async () => {
    const r = await createReport(db, { title: 'Standup' }, HUMAN);
    expect(await updateReport(db, r.id, { projectId: 'demo' }, HUMAN)).toMatchObject({ projectId: 'demo', version: 2 });
    expect(await updateReport(db, r.id, { projectId: null }, HUMAN)).toMatchObject({ projectId: null, version: 3 });
    expect(await updateReport(db, r.id, { projectId: null }, HUMAN)).toMatchObject({ version: 3 }); // nothing changed
    expect(await updateReport(db, r.id, { keepMedia: true }, HUMAN)).toMatchObject({ keepMedia: true, version: 4 });
    await expect(updateReport(db, r.id, { projectId: 'global' }, HUMAN)).rejects.toThrow(/not to "global"/);
  });

  it('lists reports without a project as "none" and counts them among the open ones', async () => {
    const none = await createReport(db, { title: 'Meeting' }, HUMAN);
    const withProject = await createReport(db, { projectId: 'demo', title: 'Crash' }, HUMAN);
    expect((await pageReports(db, { projectId: 'none' })).items.map((r) => r.id)).toEqual([none.id]);
    expect((await pageReports(db, { projectId: 'demo' })).items.map((r) => r.id)).toEqual([withProject.id]);
    expect((await pageReports(db, {})).total).toBe(2);
    expect(await openReportCounts(db)).toEqual({ demo: 1, none: 1 });
  });
});

describe('Keep media', () => {
  const store = new MediaStore(mkdtempSync(join(tmpdir(), 'tabula-keep-media-')), 1024 * 1024);

  async function closedWithVoice(closedAt: Date, keepMedia = false) {
    const r = await createReport(db, { title: 'Meeting' }, HUMAN);
    await db.update(reports).set({ status: 'done', closedAt, keepMedia }).where(eq(reports.id, r.id));
    const id = randomUUID();
    await db.insert(reportAttachments).values({
      id, reportId: r.id, kind: 'audio', mime: 'audio/wav', size: 10, sha256: 'x', fileName: 'voice.wav', storageKey: `${r.id}/${id}.wav`, createdBy: 'human',
    });
    return { reportId: r.id, attachmentId: id };
  }
  const purgedAt = async (id: string) =>
    (await db.select({ at: reportAttachments.purgedAt }).from(reportAttachments).where(eq(reportAttachments.id, id)))[0]!.at;

  it('keeps the recordings while it is on, and deletes them at the next run once it is turned off', async () => {
    const closed = new Date('2026-11-01T10:00:00.000Z');
    const now = new Date('2026-11-09T10:00:00.000Z');
    const kept = await closedWithVoice(closed, true);
    const plain = await closedWithVoice(closed);
    expect(await purgeClosedMedia(db, store, 24, now)).toBe(1);
    expect(await purgedAt(plain.attachmentId)).not.toBeNull();
    expect(await purgedAt(kept.attachmentId)).toBeNull();
    await updateReport(db, kept.reportId, { keepMedia: false }, HUMAN);
    expect(await purgeClosedMedia(db, store, 24, new Date(now.getTime() + 15 * 60 * 1000))).toBe(1);
    expect(await purgedAt(kept.attachmentId)).not.toBeNull();
  });

  it('checks the report again before each delete: Keep media turned on after the selection keeps the file', async () => {
    const closed = new Date('2026-11-01T10:00:00.000Z');
    const now = new Date('2026-11-09T10:00:00.000Z');
    const a = await closedWithVoice(closed);
    // The user turns Keep media on after the run selected the file and before it deletes it.
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver);
        return async (...args: Parameters<typeof db.transaction>) => {
          await db.update(reports).set({ keepMedia: true }).where(eq(reports.id, a.reportId));
          return target.transaction(...args);
        };
      },
    });
    const removed: string[] = [];
    const spy = { remove: async (key: string) => void removed.push(key) } as unknown as MediaStore;
    expect(await purgeClosedMedia(racing, spy, 24, now)).toBe(0);
    expect(removed).toEqual([]);
    expect(await purgedAt(a.attachmentId)).toBeNull();
  });
});

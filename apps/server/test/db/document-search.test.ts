import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { reportAttachments, reportDocuments, reports, reportTranscripts } from '../../src/db/schema.js';
import { pageReports } from '../../src/domain/reports.js';
import { quickSearch } from '../../src/domain/search.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();

async function insertReport(title: string, body: string, status: 'new' | 'done' = 'new') {
  const [r] = await db.insert(reports).values({ projectId: 'demo', title, body, status, source: 'human', editedBy: 'human' }).returning();
  return r!;
}

async function addAttachment(reportId: string, kind: 'audio' | 'document', mime: string, fileName: string) {
  const id = randomUUID();
  await db.insert(reportAttachments).values({
    id, reportId, kind, mime, size: 1, sha256: 'x', fileName, storageKey: `${reportId}/${id}`, createdBy: 'human',
  });
  return id;
}

async function addDocument(reportId: string, text: string) {
  const id = await addAttachment(reportId, 'document', 'application/pdf', 'd.pdf');
  await db.insert(reportDocuments).values({ attachmentId: id, text, source: 'fornax', characters: text.length });
  return id;
}

async function reportWithDocument(title: string, body: string, text: string) {
  const r = await insertReport(title, body);
  await addDocument(r.id, text);
  return r;
}

describe('document texts in search', () => {
  it('finds a report by the words of its document in the report list and the quick search', async () => {
    await seedProject(db, 'demo');
    const r = await reportWithDocument('Contract', '', 'Zmluva o dielo s pokutou za omeškanie');
    expect((await pageReports(db, { q: 'pokut' })).items.map((x) => x.id)).toEqual([r.id]);
    expect((await pageReports(db, { q: 'gitara' })).total).toBe(0);
    const hits = await quickSearch(db, { q: 'omeškan' });
    expect(hits).toMatchObject([{ id: r.id, type: 'report', project: 'demo', title: 'Contract' }]);
    expect(hits[0]!.snippet).toContain('**omeškanie**');
  });

  it('lists a report once when its text, a transcript and a document all match', async () => {
    await seedProject(db, 'demo');
    const r = await insertReport('Freeze on play', 'The player freezes');
    const audio = await addAttachment(r.id, 'audio', 'audio/wav', 'v.wav');
    await db.insert(reportTranscripts).values({ attachmentId: audio, language: 'en', model: 'large-v3', text: 'freeze again', segments: [] });
    await addDocument(r.id, 'freeze log');
    expect((await pageReports(db, { q: 'freez' })).total).toBe(1);
    const hits = await quickSearch(db, { q: 'freez' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain('**freeze**');
  });

  it('finds a closed report by its document after the file was purged', async () => {
    await seedProject(db, 'demo');
    const r = await insertReport('Old contract', '', 'done');
    const id = await addDocument(r.id, 'Zmluva o dielo s pokutou');
    await db.update(reportAttachments).set({ purgedAt: new Date() }).where(eq(reportAttachments.id, id));
    expect((await pageReports(db, { q: 'pokut', status: 'all' })).items.map((x) => x.id)).toEqual([r.id]);
    expect((await pageReports(db, { q: 'pokut' })).total).toBe(0);
    expect(await quickSearch(db, { q: 'pokut' })).toMatchObject([{ id: r.id, status: 'deprecated' }]);
  });
});

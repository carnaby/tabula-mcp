import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { reportAttachments, reportJobs, reports } from '../../src/db/schema.js';
import {
  backfillDocuments, documentPrefixes, documentStates, enqueueParse, getDocumentText, readTextFile, retryDocument, storeDocumentText, storeFileText,
  storeParsedDocument,
} from '../../src/domain/documents.js';
import { DOCUMENT_GONE, enqueueTranscription, failPendingJobs, MEDIA_GONE, transcriptStates } from '../../src/domain/jobs.js';
import { MediaStore } from '../../src/media/store.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const store = new MediaStore(mkdtempSync(join(tmpdir(), 'tabula-documents-media-')), 10 * 1024 * 1024);
beforeEach(() => seedProject(db, 'demo'));

/** A report with one document attachment, written straight to the database; the file only when `body` is given. */
async function document(opts: { mime?: string; ext?: string; body?: Buffer | null; purged?: boolean; closed?: boolean } = {}) {
  const [r] = await db
    .insert(reports)
    .values({
      projectId: 'demo', title: 'Minutes', source: 'human', editedBy: 'human',
      ...(opts.closed ? { status: 'done' as const, closedAt: new Date() } : {}),
    })
    .returning();
  const id = randomUUID();
  const key = `${r!.id}/${id}.${opts.ext ?? 'md'}`;
  const body = opts.body === undefined ? Buffer.from('x') : opts.body;
  if (body) await store.writeBuffer(key, body);
  const [a] = await db
    .insert(reportAttachments)
    .values({
      id, reportId: r!.id, kind: 'document', mime: opts.mime ?? 'text/markdown; charset=utf-8', size: body?.length ?? 0,
      sha256: 'x', fileName: `minutes.${opts.ext ?? 'md'}`, storageKey: key, createdBy: 'human',
      purgedAt: opts.purged ? new Date() : null,
    })
    .returning();
  return a!;
}

describe('document text', () => {
  it('reads a text file exactly, without the BOM', async () => {
    const a = await document({ body: Buffer.from('\uFEFF# Zápis\r\n\n- [ ] úloha & ďalšia\n', 'utf8') });
    expect(await readTextFile(store, a.storageKey)).toEqual({ text: '# Zápis\r\n\n- [ ] úloha & ďalšia\n', truncated: false });
  });

  it('reads at most the first bytes of a text file, without a broken character at the end, and marks it truncated', async () => {
    const a = await document({ body: Buffer.from('ažž', 'utf8') }); // 1 + 2 + 2 bytes
    expect(await readTextFile(store, a.storageKey, 4)).toEqual({ text: 'až', truncated: true });
    expect(await readTextFile(store, a.storageKey, 5)).toEqual({ text: 'ažž', truncated: false });
  });

  it('stores a text with its counts, replaces it on a second store, strips NUL, and keeps it after the file is purged', async () => {
    const NUL = String.fromCharCode(0);
    const a = await document({ mime: 'application/pdf', ext: 'pdf' });
    expect(await storeDocumentText(db, a.id, { text: `a${NUL}b\n| x |`, source: 'fornax', model: 'docling 2.151.1', pages: 1, tables: 1 }))
      .toEqual({ characters: 8, truncated: false });
    await storeDocumentText(db, a.id, { text: 'z'.repeat(1_000_005), source: 'fornax', model: null, pages: null, tables: null });
    expect(await getDocumentText(db, a.id)).toMatchObject({ characters: 1_000_000, truncated: true, model: null, pages: null });
    await db.update(reportAttachments).set({ purgedAt: new Date() }).where(eq(reportAttachments.id, a.id));
    expect(await getDocumentText(db, a.id)).toBeDefined();
  });

  it('stores the text of a TXT or Markdown attachment from its file, and nothing when the file is gone', async () => {
    const md = await document({ body: Buffer.from('# Hello\n', 'utf8') });
    expect(await storeFileText(db, store, md)).toBe(true);
    expect(await getDocumentText(db, md.id)).toMatchObject({ text: '# Hello\n', source: 'file', model: null, characters: 8, truncated: false });
    const gone = await document({ body: null });
    expect(await storeFileText(db, store, gone)).toBe(false);
    expect(await getDocumentText(db, gone.id)).toBeUndefined();
  });

  it('gives the beginning of several texts without reading them whole', async () => {
    const a = await document();
    const b = await document();
    await storeDocumentText(db, a.id, { text: 'a'.repeat(10), source: 'file', model: null, pages: null, tables: null });
    await storeDocumentText(db, b.id, { text: 'b'.repeat(20_000), source: 'file', model: null, pages: null, tables: null });
    const p = await documentPrefixes(db, [a.id, b.id]);
    expect(p.get(a.id)).toHaveLength(10);
    expect(p.get(b.id)).toHaveLength(8_001);
  });
});

const jobOf = async (attachmentId: string) => (await db.select().from(reportJobs).where(eq(reportJobs.attachmentId, attachmentId)))[0]!;
const setJob = (attachmentId: string, values: Partial<typeof reportJobs.$inferInsert>) =>
  db.update(reportJobs).set(values).where(eq(reportJobs.attachmentId, attachmentId));
/** A job as the sync leaves it while Fornax works on it. */
const IN_FORNAX = { status: 'running' as const, attempts: 1, fornaxJobId: 'j_1', fornaxChange: 'c1', note: 'waiting', submitting: false };
const PDF = { mime: 'application/pdf', ext: 'pdf' };
const parsed = (id: string, text: string) =>
  db.transaction(async (tx) => storeParsedDocument(tx, (await jobOf(id)).id, { text, model: 'docling 2.151.1', pages: 1, tables: 0 }));

describe('reading documents with Fornax', () => {
  it('queues a PDF once; the states of reading and of transcription never mix', async () => {
    const pdf = await document(PDF);
    await enqueueParse(db, pdf.id);
    await enqueueParse(db, pdf.id);
    expect(await db.select().from(reportJobs)).toMatchObject([{ attachmentId: pdf.id, kind: 'parse', status: 'queued' }]);
    expect((await documentStates(db, [pdf.id])).get(pdf.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect((await transcriptStates(db, [pdf.id])).get(pdf.id)).toBeUndefined();
  });

  it('stores the text Fornax read and finishes the job; an empty text is done with 0 characters', async () => {
    const pdf = await document(PDF);
    await enqueueParse(db, pdf.id);
    expect(await parsed(pdf.id, '# T\n')).toEqual({ characters: 4 });
    expect((await documentStates(db, [pdf.id])).get(pdf.id)).toEqual({
      status: 'done', source: 'fornax', model: 'docling 2.151.1', pages: 1, tables: 0, characters: 4, truncated: false, createdAt: expect.any(String),
    });
    expect(await jobOf(pdf.id)).toMatchObject({ status: 'done', error: null, note: null });
    const empty = await document(PDF);
    await enqueueParse(db, empty.id);
    await parsed(empty.id, '');
    expect((await documentStates(db, [empty.id])).get(empty.id)).toMatchObject({ status: 'done', characters: 0 });
    await expect(db.transaction((tx) => storeParsedDocument(tx, randomUUID(), { text: 'x', model: null, pages: null, tables: null })))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('shows the state of reading: waiting with the note and the back-off, running with progress, failed with the error', async () => {
    const a = await document(PDF);
    await enqueueParse(db, a.id);
    const now = new Date(Date.now() + 60_000);
    const state = async () => (await documentStates(db, [a.id], now)).get(a.id);
    expect(await state()).toEqual({ status: 'queued', attempts: 0, error: null, retryAt: null, note: null });
    await setJob(a.id, { ...IN_FORNAX, status: 'queued', note: 'the worker is offline' });
    expect(await state()).toEqual({ status: 'queued', attempts: 1, error: null, retryAt: null, note: 'the worker is offline' });
    const later = new Date(now.getTime() + 60_000);
    await setJob(a.id, { fornaxJobId: null, note: null, error: 'Fornax is unreachable', runAfter: later });
    expect(await state()).toEqual({ status: 'queued', attempts: 1, error: 'Fornax is unreachable', retryAt: later.toISOString(), note: null });
    await setJob(a.id, { ...IN_FORNAX, note: null, error: null, progress: 42, progressMessage: 'page 3 of 7' });
    expect(await state()).toEqual({
      status: 'running', attempts: 1, error: null, retryAt: null, note: null, progress: 42, progressMessage: 'page 3 of 7',
    });
    await setJob(a.id, { status: 'failed', error: 'boom' });
    expect(await state()).toEqual({ status: 'failed', attempts: 1, error: 'boom', retryAt: null });
  });

  it('Try again: starts a failed document over, reads a text file anew, and refuses what cannot be read', async () => {
    const pdf = await document(PDF);
    await enqueueParse(db, pdf.id);
    await setJob(pdf.id, { status: 'failed', attempts: 3, error: 'boom', fornaxJobId: 'j_1' });
    expect(await retryDocument(db, store, pdf.id, { fornax: true })).toMatchObject({ status: 'queued', attempts: 0, error: null });
    expect(await jobOf(pdf.id)).toMatchObject({ fornaxJobId: null, submitting: false });
    await expect(retryDocument(db, store, pdf.id, { fornax: true })).rejects.toMatchObject({
      code: 'conflict', message: expect.stringContaining('already waiting for Fornax or being read'),
    });
    const fresh = await document(PDF);
    expect(await retryDocument(db, store, fresh.id, { fornax: true })).toMatchObject({ status: 'queued' });
    await expect(retryDocument(db, store, fresh.id, { fornax: false })).rejects.toMatchObject({
      code: 'conflict', message: expect.stringContaining('TABULA_FORNAX_URL'),
    });
    const md = await document({ body: Buffer.from('ahoj\n') });
    expect(await retryDocument(db, store, md.id, { fornax: false })).toMatchObject({ status: 'done', source: 'file', characters: 5 });
    await store.writeBuffer(md.storageKey, Buffer.from('nový text\n'));
    expect(await retryDocument(db, store, md.id, { fornax: false })).toMatchObject({ status: 'done', characters: 10 });
    const mdGone = await document({ body: null });
    await expect(retryDocument(db, store, mdGone.id, { fornax: false })).rejects.toMatchObject({
      code: 'conflict', message: expect.stringContaining('deleted after the report was closed'),
    });
    const odt = await document({ mime: 'application/vnd.oasis.opendocument.text', ext: 'odt' });
    await expect(retryDocument(db, store, odt.id, { fornax: true })).rejects.toMatchObject({ code: 'bad_request' });
    const purged = await document({ ...PDF, purged: true });
    await expect(retryDocument(db, store, purged.id, { fornax: true })).rejects.toMatchObject({
      code: 'conflict', message: expect.stringContaining('deleted after the report was closed'),
    });
    const read = await document(PDF);
    await enqueueParse(db, read.id);
    await parsed(read.id, 'text');
    await expect(retryDocument(db, store, read.id, { fornax: true })).rejects.toMatchObject({
      code: 'conflict', message: expect.stringContaining('has been read already'),
    });
    await expect(retryDocument(db, store, randomUUID(), { fornax: true })).rejects.toMatchObject({ code: 'not_found' });
    expect(await db.select().from(reportJobs).where(eq(reportJobs.attachmentId, odt.id))).toEqual([]);
    expect(await db.select().from(reportJobs).where(eq(reportJobs.attachmentId, purged.id))).toEqual([]);
  });

  it('fails the reading of a deleted document with the document reason, and a recording with its own', async () => {
    const pdf = await document(PDF);
    await enqueueParse(db, pdf.id);
    const [r] = await db.insert(reports).values({ projectId: 'demo', title: 'Call', source: 'human', editedBy: 'human' }).returning();
    const [audio] = await db
      .insert(reportAttachments)
      .values({
        reportId: r!.id, kind: 'audio', mime: 'audio/wav', size: 1, sha256: 'x', fileName: 'rec', storageKey: `${r!.id}/rec.wav`, createdBy: 'human',
      })
      .returning();
    await enqueueTranscription(db, audio!.id);
    await failPendingJobs(db, [pdf.id, audio!.id]);
    expect(await jobOf(pdf.id)).toMatchObject({ status: 'failed', error: DOCUMENT_GONE });
    expect(await jobOf(audio!.id)).toMatchObject({ status: 'failed', error: MEDIA_GONE });
  });

  it('fills in what was uploaded before: texts of TXT and MD on disk, Fornax jobs for PDF and Office on disk, once', async () => {
    const md = await document({ body: Buffer.from('# Old\n'), closed: true }); // a closed report that keeps its media counts too
    const mdGone = await document({ body: null });
    const pdf = await document(PDF);
    const pdfGone = await document({ ...PDF, body: null });
    const docx = await document({ mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' });
    await enqueueParse(db, docx.id);
    await setJob(docx.id, { status: 'failed', error: 'boom' });
    const read = await document(PDF);
    await storeDocumentText(db, read.id, { text: 'text', source: 'fornax', model: null, pages: null, tables: null });
    const odt = await document({ mime: 'application/vnd.oasis.opendocument.text', ext: 'odt' });
    const purged = await document({ ...PDF, purged: true });
    const jobAttachments = async () => (await db.select().from(reportJobs)).map((j) => j.attachmentId).sort();

    expect(await backfillDocuments(db, store, { fornax: false })).toEqual({ texts: 1, queued: 0 });
    expect(await getDocumentText(db, md.id)).toMatchObject({ text: '# Old\n', source: 'file' });
    expect(await jobAttachments()).toEqual([docx.id]);
    expect(await backfillDocuments(db, store, { fornax: true })).toEqual({ texts: 0, queued: 1 });
    expect(await backfillDocuments(db, store, { fornax: true })).toEqual({ texts: 0, queued: 0 });
    expect(await jobAttachments()).toEqual([docx.id, pdf.id].sort());
    expect(await jobOf(pdf.id)).toMatchObject({ kind: 'parse', status: 'queued' });
    expect(await jobOf(docx.id)).toMatchObject({ status: 'failed', error: 'boom' });
    for (const a of [mdGone, pdfGone, odt, purged]) expect(await getDocumentText(db, a.id)).toBeUndefined();
  });

  it('goes on with the next document when one cannot be read, and tells which', async () => {
    const bad = await document({ body: Buffer.from('a') });
    const good = await document({ body: Buffer.from('b') });
    const errors: string[] = [];
    // A store that fails for one key only.
    const flaky = Object.create(store) as MediaStore;
    flaky.size = async (key: string) => {
      if (key === bad.storageKey) throw new Error('disk error');
      return store.size(key);
    };
    expect(await backfillDocuments(db, flaky, { fornax: false, onError: (_e, id) => errors.push(id) })).toEqual({ texts: 1, queued: 0 });
    expect(errors).toEqual([bad.id]);
    expect(await getDocumentText(db, good.id)).toMatchObject({ text: 'b' });
  });
});

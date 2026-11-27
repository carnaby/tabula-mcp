import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportAttachments, reportJobs, reports } from '../../src/db/schema.js';
import { backfillDocuments } from '../../src/domain/documents.js';
import { addAttachment, purgeClosedMedia } from '../../src/domain/reports.js';
import { buildApp } from '../../src/http/app.js';
import { MediaStore } from '../../src/media/store.js';
import { seedProject, TEST_APP_TOKEN, TEST_TOKEN, testConfig, useTestAppToken, useTestDb, useTestTokens } from '../helpers.js';
import { PNG } from '../media-fixtures.js';

const db = useTestDb();
useTestTokens(db);
useTestAppToken(db);
const mediaDir = mkdtempSync(join(tmpdir(), 'tabula-documents-'));
const config = testConfig({ media: { dir: mediaDir, maxBytes: 2 * 1024 * 1024, purgeAfterHours: 24, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } });
const store = new MediaStore(mediaDir, config.media.maxBytes);
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config, db, store });
});
afterAll(() => app.close());
beforeEach(() => seedProject(db, 'demo'));

const NUL = String.fromCharCode(0);
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(200, 0x20)]);
/** A ZIP's local file header: what OOXML and ODF files start with. */
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200)]);
const MD = Buffer.from('# Zápisnica\n\nRozhodli sme o termíne.\n', 'utf8');
const api = { authorization: `Bearer ${TEST_TOKEN}` };
const newReport = async () => (await app.inject({ method: 'POST', url: '/api/reports', headers: api, payload: { projectId: 'demo' } })).json().id as string;
const viaApi = (id: string, body: Buffer, type: string, name: string) =>
  app.inject({ method: 'POST', url: `/api/reports/${id}/attachments`, payload: body, headers: { ...api, 'content-type': type, 'x-file-name': encodeURIComponent(name) } });
const viaApp = (id: string, body: Buffer, type: string, name: string) =>
  app.inject({
    method: 'POST', url: `/app-api/v1/reports/${id}/attachments`, payload: body,
    headers: { authorization: `Bearer ${TEST_APP_TOKEN}`, 'content-type': type, 'x-filename': encodeURIComponent(name) },
  });

describe('documents as report attachments', () => {
  it('stores PDF, DOCX and Markdown as documents over /api and /app-api, without transcription', async () => {
    const r = await newReport();
    const pdf = await viaApi(r, PDF, 'application/pdf', 'Zmluva.pdf');
    expect(pdf.statusCode).toBe(201);
    expect(pdf.json()).toMatchObject({ kind: 'document', mime: 'application/pdf', fileName: 'Zmluva.pdf', size: PDF.length, durationMs: null, transcript: null });
    const docx = await viaApp(r, DOCX, DOCX_TYPE, 'Ponuka.docx');
    expect(docx.statusCode).toBe(201);
    expect(docx.json()).toEqual({ id: expect.any(String), kind: 'document', mime: DOCX_TYPE, size: DOCX.length });
    expect((await viaApp(r, MD, 'text/markdown', 'notes.md')).json()).toMatchObject({ kind: 'document', mime: 'text/markdown; charset=utf-8' });
    // The same types over the other path: a PDF through /app-api, a DOCX through /api.
    expect((await viaApp(r, PDF, 'application/pdf', 'Zmluva 2.pdf')).json()).toMatchObject({ kind: 'document', mime: 'application/pdf' });
    expect((await viaApi(r, DOCX, DOCX_TYPE, 'Ponuka 2.docx')).json()).toMatchObject({ kind: 'document', mime: DOCX_TYPE, fileName: 'Ponuka 2.docx' });
    const jobs = await db.select().from(reportJobs);
    expect(jobs.map((j) => j.kind)).toEqual(['parse', 'parse', 'parse', 'parse']); // 2 PDF + 2 DOCX, no Markdown, no transcribe
    const view = (await app.inject({ method: 'GET', url: `/api/reports/${r}`, headers: api })).json();
    expect(view.attachments.find((a: { id: string }) => a.id === pdf.json().id).document).toMatchObject({ status: 'queued' });
    const listed = (await app.inject({ method: 'GET', url: '/api/reports?project=demo', headers: api })).json();
    expect(listed.items[0].counts).toEqual({ image: 0, video: 0, audio: 0, frame: 0, document: 5 });
  });

  it('downloads a document as an attachment with nosniff; a photo still opens inline', async () => {
    const r = await newReport();
    const doc = (await viaApi(r, PDF, 'application/pdf', 'Zmluva.pdf')).json();
    const res = await app.inject({ method: 'GET', url: doc.url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''Zmluva.pdf`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.equals(PDF)).toBe(true);
    const photo = (await viaApi(r, PNG, 'image/png', 'p.png')).json();
    expect((await app.inject({ method: 'GET', url: photo.url })).headers['content-disposition']).toMatch(/^inline;/);
  });

  it('names a document after its verified type, so a download never saves a page, a script or a program', async () => {
    const r = await newReport();
    const html = await viaApi(r, Buffer.from('<script>alert(1)</script>', 'utf8'), 'text/plain', 'evil.html');
    expect(html.json()).toMatchObject({ kind: 'document', fileName: 'evil.html.txt' });
    const download = await app.inject({ method: 'GET', url: html.json().url });
    expect(download.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''evil.html.txt`);
    expect(download.headers['content-type']).toBe('text/plain; charset=utf-8');
    const jar = (await viaApp(r, DOCX, DOCX_TYPE, 'tool.jar')).json();
    const kept = (await viaApp(r, PDF, 'application/pdf', 'report.pdf')).json();
    const upper = (await viaApi(r, MD, 'text/markdown', 'Notes.MD')).json();
    const long = (await viaApi(r, MD, 'text/markdown', 'notes.markdown')).json();
    const bare = (await viaApi(r, PDF, 'application/pdf', 'Zmluva')).json();
    const names = new Map((await db.select().from(reportAttachments)).map((a) => [a.id, a.fileName]));
    expect([jar.id, kept.id, upper.id, long.id, bare.id].map((id) => names.get(id))).toEqual(['tool.jar.docx', 'report.pdf', 'Notes.MD', 'notes.markdown', 'Zmluva.pdf']);
    // At the length limit the extension still fits.
    const longName = `${'a'.repeat(199)}.html`;
    expect((await viaApi(r, MD, 'text/plain', longName)).json().fileName).toBe(`${'a'.repeat(196)}.txt`);
  });

  it.each([
    ['a PDF without its signature', Buffer.concat([Buffer.from('<html>', 'latin1'), Buffer.alloc(200, 0x20)]), 'application/pdf'],
    ['a DOCX that is no ZIP', Buffer.alloc(200, 0x41), DOCX_TYPE],
    ['HTML', Buffer.from('<html><script>alert(1)</script></html>'.padEnd(200)), 'text/html'],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'.padEnd(200)), 'image/svg+xml'],
    ['text with a NUL', Buffer.from(`a${NUL}b`.padEnd(200), 'utf8'), 'text/plain'],
    ['text with a NUL after the first chunk', Buffer.concat([Buffer.alloc(100_000, 0x61), Buffer.from([0]), Buffer.alloc(10, 0x61)]), 'text/plain'],
    ['text that is not UTF-8', Buffer.concat([Buffer.alloc(100, 0x61), Buffer.from([0xc3, 0x28]), Buffer.alloc(100, 0x61)]), 'text/markdown'],
  ])('refuses %s: 415 on /app-api, 400 on /api, nothing stored', async (_name, body, type) => {
    const r = await newReport();
    const viaAppApi = await viaApp(r, body, type, 'file');
    expect(viaAppApi.statusCode).toBe(415);
    expect(viaAppApi.json()).toEqual({ error: 'unsupported_media_type', message: expect.any(String) });
    expect((await viaApi(r, body, type, 'file')).statusCode).toBe(400);
    expect(await db.select().from(reportAttachments)).toEqual([]);
    expect(readdirSync(join(mediaDir, '.tmp'))).toEqual([]);
  });

  it('refuses a PDF sent as application/octet-stream and names Content-Type in the message', async () => {
    const res = await viaApp(await newReport(), PDF, 'application/octet-stream', 'Zmluva.pdf');
    expect(res.statusCode).toBe(415);
    expect(res.json().message).toMatch(/Content-Type/);
  });

  it('deletes the documents of a closed report after the grace period, like recordings, and keeps photos', async () => {
    const r = await newReport();
    const doc = (await viaApi(r, PDF, 'application/pdf', 'a.pdf')).json();
    const photo = (await viaApi(r, PNG, 'image/png', 'p.png')).json();
    await db.update(reports).set({ status: 'done', closedAt: new Date(Date.now() - 3600_000) }).where(eq(reports.id, r));
    expect(await purgeClosedMedia(db, store, 0, new Date())).toBe(1);
    const rows = await db.select().from(reportAttachments);
    expect(rows.find((x) => x.id === doc.id)!.purgedAt).not.toBeNull();
    expect(rows.find((x) => x.id === photo.id)!.purgedAt).toBeNull();
  });

  it('reads a Markdown or text file at upload and serves its exact text', async () => {
    const r = await newReport();
    const md = (await viaApp(r, MD, 'text/markdown', 'notes.md')).json();
    const view = (await app.inject({ method: 'GET', url: `/api/reports/${r}`, headers: api })).json();
    expect(view.attachments[0].document).toMatchObject({ status: 'done', source: 'file', characters: MD.toString('utf8').length, pages: null });
    const text = await app.inject({ method: 'GET', url: `/api/attachments/${md.id}/document`, headers: api });
    expect(text.statusCode).toBe(200);
    expect(text.json()).toMatchObject({ text: MD.toString('utf8'), truncated: false, source: 'file' });
  });

  it('leaves ODT and photos without a document state', async () => {
    const r = await newReport();
    const odt = await viaApi(r, DOCX, 'application/vnd.oasis.opendocument.text', 'a.odt');
    expect(odt.statusCode).toBe(201);
    expect((await viaApi(r, PNG, 'image/png', 'p.png')).statusCode).toBe(201);
    const view = (await app.inject({ method: 'GET', url: `/api/reports/${r}`, headers: api })).json();
    expect(view.attachments).toHaveLength(2);
    for (const a of view.attachments) expect(a.document).toBeNull();
    expect(await db.select().from(reportJobs)).toEqual([]);
  });

  it('queues no Fornax job without Fornax, and Try again says why', async () => {
    const noFornax = await buildApp({ config: { ...config, fornax: undefined }, db, store });
    try {
      const r = await newReport();
      const up = await noFornax.inject({
        method: 'POST', url: `/api/reports/${r}/attachments`, payload: PDF,
        headers: { ...api, 'content-type': 'application/pdf', 'x-file-name': 'a.pdf' },
      });
      expect(up.statusCode).toBe(201);
      expect(up.json().document).toEqual({ status: 'none' });
      expect(await db.select().from(reportJobs)).toEqual([]);
      const retry = await noFornax.inject({ method: 'POST', url: `/api/attachments/${up.json().id}/document/retry`, headers: api });
      expect(retry.statusCode).toBe(409);
      expect(retry.json().message).toContain('TABULA_FORNAX_URL');
    } finally {
      await noFornax.close();
    }
  });

  it('Try again restarts a failed reading of a PDF', async () => {
    const r = await newReport();
    const pdf = (await viaApi(r, PDF, 'application/pdf', 'a.pdf')).json();
    await db.update(reportJobs).set({ status: 'failed', error: 'boom', attempts: 3 }).where(eq(reportJobs.attachmentId, pdf.id));
    const retry = await app.inject({ method: 'POST', url: `/api/attachments/${pdf.id}/document/retry`, headers: api });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: 'queued', attempts: 0 });
    const again = await app.inject({ method: 'POST', url: `/api/attachments/${pdf.id}/document/retry`, headers: api });
    expect(again.statusCode).toBe(409);
  });

  it('keeps a stored text after the file is purged', async () => {
    const r = await newReport();
    const md = (await viaApi(r, MD, 'text/markdown', 'notes.md')).json();
    await db.update(reports).set({ status: 'done', closedAt: new Date(Date.now() - 3600_000) }).where(eq(reports.id, r));
    expect(await purgeClosedMedia(db, store, 0, new Date())).toBe(1);
    const text = await app.inject({ method: 'GET', url: `/api/attachments/${md.id}/document`, headers: api });
    expect(text.statusCode).toBe(200);
    expect(text.json().text).toBe(MD.toString('utf8'));
  });

  it('answers 404 for the text of a document without one', async () => {
    const r = await newReport();
    const pdf = (await viaApi(r, PDF, 'application/pdf', 'a.pdf')).json();
    const res = await app.inject({ method: 'GET', url: `/api/attachments/${pdf.id}/document`, headers: api });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain('has no text yet');
  });

  it('still answers 201 when the text of an upload cannot be stored, and backfill fills it in later', async () => {
    const r = await newReport();
    const spy = vi.spyOn(store, 'size').mockRejectedValueOnce(new Error('disk gone'));
    const up = await viaApi(r, MD, 'text/markdown', 'n.md');
    spy.mockRestore();
    expect(up.statusCode).toBe(201);
    expect(up.json().document).toEqual({ status: 'none' });
    expect((await app.inject({ method: 'GET', url: `/api/attachments/${up.json().id}/document`, headers: api })).statusCode).toBe(404);
    expect(await backfillDocuments(db, store, { fornax: true })).toEqual({ texts: 1, queued: 0 });
    expect((await app.inject({ method: 'GET', url: `/api/attachments/${up.json().id}/document`, headers: api })).statusCode).toBe(200);
  });

  it('reports a failed text store to onError and still returns the row', async () => {
    const r = await newReport();
    const errors: Array<[unknown, string]> = [];
    const upload = await store.receive(Readable.from([MD]), 'text/markdown');
    vi.spyOn(store, 'size').mockRejectedValueOnce(new Error('disk gone'));
    const row = await addAttachment(db, store, config.media, r, upload, 'n.md', { source: 'human', label: 'test' }, { onError: (e, id) => errors.push([e, id]) });
    expect(row.kind).toBe('document');
    expect(errors).toHaveLength(1);
    expect((errors[0]![0] as Error).message).toBe('disk gone');
    expect(errors[0]![1]).toBe(row.id);
  });
});

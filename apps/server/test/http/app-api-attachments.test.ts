import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reportAttachments, reportJobs, reports } from '../../src/db/schema.js';
import { buildApp } from '../../src/http/app.js';
import { MediaStore } from '../../src/media/store.js';
import { seedProject, TEST_APP_TOKEN, testConfig, useTestAppToken, useTestDb } from '../helpers.js';
import { PNG } from '../media-fixtures.js';

const db = useTestDb();
useTestAppToken(db);
const mediaDir = mkdtempSync(join(tmpdir(), 'tabula-app-media-'));
const config = testConfig({ media: { dir: mediaDir, maxBytes: 2 * 1024 * 1024, purgeAfterHours: 24, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } });
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config, db, store: new MediaStore(mediaDir, config.media.maxBytes) });
});
afterAll(() => app.close());
beforeEach(() => seedProject(db, 'beta'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const auth = { authorization: `Bearer ${TEST_APP_TOKEN}` };
/** An MP3 as its first bytes say; built from numbers, so no escape sequence is typed. */
const mp3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(100)]);
const newReport = async () => (await app.inject({ method: 'POST', url: '/app-api/v1/reports', headers: auth, payload: { project: 'beta' } })).json().id as string;
const upload = (reportId: string, body: Buffer, type: string, name?: string) =>
  app.inject({
    method: 'POST', url: `/app-api/v1/reports/${reportId}/attachments`, payload: body,
    headers: { ...auth, 'content-type': type, ...(name !== undefined && { 'x-filename': name }) },
  });

describe('POST /app-api/v1/reports/:id/attachments', () => {
  it('stores a recording, queues its transcription and answers with the attachment only', async () => {
    const r = await newReport();
    const res = await upload(r, mp3, 'audio/mpeg', encodeURIComponent('Hlasová poznámka.mp3'));
    expect(res.statusCode).toBe(201);
    const a = res.json();
    expect(a).toEqual({ id: expect.stringMatching(UUID), kind: 'audio', mime: 'audio/mpeg', size: mp3.length });
    const [row] = await db.select().from(reportAttachments).where(eq(reportAttachments.id, a.id));
    expect(row).toMatchObject({ reportId: r, fileName: 'Hlasová poznámka.mp3', createdBy: 'klara', createdByModel: null });
    expect(await db.select({ attachmentId: reportJobs.attachmentId, status: reportJobs.status }).from(reportJobs)).toEqual([{ attachmentId: a.id, status: 'queued' }]);
  });

  it('stores a photo without transcription', async () => {
    const res = await upload(await newReport(), PNG, 'image/png', 'screen.png');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'image', mime: 'image/png', size: PNG.length });
    expect(await db.select().from(reportJobs)).toEqual([]);
  });

  it('refuses a closed report with 409 report_closed before reading the body', async () => {
    const r = await newReport();
    await db.update(reports).set({ status: 'done', closedAt: new Date() }).where(eq(reports.id, r));
    const res = await upload(r, Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]), 'image/png');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'report_closed', message: expect.any(String) });
    expect(res.headers.connection).toBe('close');
  });

  it('refuses a file over the limit with 413 too_large and closes the connection', async () => {
    const res = await upload(await newReport(), Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]), 'image/png');
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'too_large', message: expect.any(String) });
    expect(res.headers.connection).toBe('close');
    expect(await db.select().from(reportAttachments)).toEqual([]);
  });

  it('refuses a type it does not store with 415 unsupported_media_type', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(200));
    const res = await upload(await newReport(), html, 'text/html', 'page.html');
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'unsupported_media_type', message: expect.any(String) });
  });

  it('answers an unknown or malformed report id with 404 report_not_found', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const res = await upload(id, PNG, 'image/png');
      expect(res.statusCode, id).toBe(404);
      expect(res.json()).toEqual({ error: 'report_not_found', message: expect.any(String) });
      expect(res.headers.connection).toBe('close');
    }
  });

  it('refuses a file name that is not URI-encoded with 400 validation_failed', async () => {
    const res = await upload(await newReport(), PNG, 'image/png', '%E0%A4%A');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_failed' });
    expect(res.headers.connection).toBe('close');
  });

  it('refuses an empty file with 400 validation_failed', async () => {
    const res = await upload(await newReport(), Buffer.alloc(0), 'image/png');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_failed', message: 'the file is empty' });
  });

  it('answers 503 unavailable and closes the connection while media storage is down', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tabula-broken-')), 'not-a-directory');
    writeFileSync(file, '');
    const broken = new MediaStore(join(file, 'media'), config.media.maxBytes);
    await broken.startup();
    // The refusal is logged as an error with its cause; this test only looks at the answer.
    const prevLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'silent';
    const app2 = await buildApp({ config, db, store: broken });
    process.env.LOG_LEVEL = prevLevel;
    try {
      const res = await app2.inject({
        method: 'POST', url: `/app-api/v1/reports/${await newReport()}/attachments`, payload: PNG,
        headers: { ...auth, 'content-type': 'image/png' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'unavailable', message: expect.stringMatching(/^media storage is not available/) });
      expect(res.headers.connection).toBe('close');
    } finally {
      await app2.close();
    }
  });
});

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { purgeClosedMedia } from '../../src/domain/reports.js';
import { buildApp } from '../../src/http/app.js';
import { MediaStore } from '../../src/media/store.js';
import { seedProject, TEST_TOKEN, testConfig, useTestDb } from '../helpers.js';
import { HAS_FFMPEG, PNG, testVideo } from '../media-fixtures.js';

const db = useTestDb();
const mediaDir = mkdtempSync(join(tmpdir(), 'tabula-media-'));
const config = testConfig({ media: { dir: mediaDir, maxBytes: 2 * 1024 * 1024, purgeAfterHours: 24, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } });
const store = new MediaStore(mediaDir, config.media.maxBytes);
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config, db, store });
});
afterAll(() => app.close());
beforeEach(() => seedProject(db, 'demo'));

const auth = { authorization: `Bearer ${TEST_TOKEN}` };
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: auth, ...(payload && { payload }) });
const upload = (reportId: string, body: Buffer, type: string, name = 'file') =>
  app.inject({
    method: 'POST', url: `/api/reports/${reportId}/attachments`, payload: body,
    headers: { ...auth, 'content-type': type, 'x-file-name': encodeURIComponent(name) },
  });
const newReport = async (body = 'The play button does nothing\nOn Android Chrome.') =>
  (await call('POST', '/api/reports', { projectId: 'demo', body })).json();

describe('bug reports', () => {
  it('creates a report with a title from the first line, edits it and keeps versions', async () => {
    const r = await newReport();
    expect(r).toMatchObject({ title: 'The play button does nothing', status: 'new', version: 1, source: 'human' });
    expect((await call('POST', '/api/reports', { projectId: 'global', body: 'x' })).statusCode).toBe(400);
    expect((await call('POST', '/api/reports', { projectId: 'nope', body: 'x' })).statusCode).toBe(404);

    const up = (await call('PATCH', `/api/reports/${r.id}`, { triage: '- [ ] fix', status: 'triaged', expectedVersion: 1 })).json();
    expect(up).toMatchObject({ version: 2, status: 'triaged', triage: '- [ ] fix' });
    expect((await call('PATCH', `/api/reports/${r.id}`, { title: 'stale', expectedVersion: 1 })).statusCode).toBe(409);

    const list = (await call('GET', '/api/reports?project=demo')).json();
    expect(list).toMatchObject({ total: 1, items: [{ id: r.id, counts: { image: 0, video: 0 } }] });
    expect((await call('GET', '/api/reports/counts')).json()).toEqual({ demo: 1 });
    expect((await call('GET', '/api/reports?q=andro')).json().total).toBe(1);
    expect((await call('GET', '/api/search?q=play%20butt')).json()[0]).toMatchObject({ type: 'report', project: 'demo' });
  });

  it('stores an upload, serves it by a signed link with ranges and safe headers', async () => {
    const r = await newReport();
    const res = await upload(r.id, PNG, 'image/png', 'screen shot.png');
    expect(res.statusCode).toBe(201);
    const a = res.json();
    expect(a).toMatchObject({ kind: 'image', mime: 'image/png', size: PNG.length, fileName: 'screen shot.png' });
    expect(a.url).toMatch(/^\/media\/[0-9a-f-]{36}\?exp=\d+&sig=/);

    const full = await app.inject({ method: 'GET', url: a.url });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.equals(PNG)).toBe(true);
    expect(full.headers).toMatchObject({ 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes' });
    expect(full.headers['content-security-policy']).toContain('sandbox');

    const part = await app.inject({ method: 'GET', url: a.url, headers: { range: 'bytes=0-7' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-7/${PNG.length}`);
    expect(part.rawPayload.equals(PNG.subarray(0, 8))).toBe(true);
    expect((await app.inject({ method: 'GET', url: a.url, headers: { range: 'bytes=999999-' } })).statusCode).toBe(416);

    // The signature replaces the token; a wrong or missing one is refused.
    expect((await app.inject({ method: 'GET', url: a.url.replace(/sig=.*/, 'sig=AAAA') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/media/${a.id}` })).statusCode).toBe(400);

    const got = (await call('GET', `/api/reports/${r.id}`)).json();
    expect(got.attachments).toHaveLength(1);

    expect((await call('DELETE', `/api/attachments/${a.id}`)).statusCode).toBe(204);
    expect(readdirSync(join(mediaDir, r.id))).toEqual([]);
  });

  it('refuses HTML, SVG and oversized files and leaves nothing behind', async () => {
    const r = await newReport();
    const html = await upload(r.id, Buffer.from('<html><script>alert(localStorage.token)</script>'.padEnd(80)), 'image/png');
    expect(html.statusCode).toBe(400);
    expect(html.json().message).toMatch(/unsupported file type/);
    expect((await upload(r.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'.padEnd(80)), 'image/svg+xml')).statusCode).toBe(400);
    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
    expect((await upload(r.id, big, 'image/png')).statusCode).toBe(413);
    expect((await upload(r.id, Buffer.alloc(0), 'image/png')).statusCode).toBe(400);
    expect(readdirSync(join(mediaDir, '.tmp'))).toEqual([]);
    expect(existsSync(join(mediaDir, r.id))).toBe(false);
  });

  it('closing a report deletes its video and audio after the grace period, keeping photos and the record', async () => {
    const r = await newReport();
    const img = (await upload(r.id, PNG, 'image/png')).json();
    const voice = (await upload(r.id, Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(100)]), 'audio/mpeg', 'voice.mp3')).json();
    expect(voice).toMatchObject({ kind: 'audio', mime: 'audio/mpeg' });

    const closed = (await call('PATCH', `/api/reports/${r.id}`, { status: 'done' })).json();
    expect(closed.closedAt).not.toBeNull();
    expect((await upload(r.id, PNG, 'image/png')).statusCode).toBe(409);

    expect(await purgeClosedMedia(db, store, 24)).toBe(0); // still within the grace period
    expect(await purgeClosedMedia(db, store, 24, new Date(Date.now() + 25 * 3600 * 1000))).toBe(1);

    const got = (await call('GET', `/api/reports/${r.id}`)).json();
    const audio = got.attachments.find((a: { id: string }) => a.id === voice.id);
    expect(audio).toMatchObject({ url: null });
    expect(audio.purgedAt).not.toBeNull();
    expect(got.attachments.find((a: { id: string }) => a.id === img.id).url).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: voice.url })).statusCode).toBe(410);

    // Reopening clears the close date.
    expect((await call('PATCH', `/api/reports/${r.id}`, { status: 'triaged' })).json().closedAt).toBeNull();

    expect((await call('DELETE', `/api/reports/${r.id}`)).statusCode).toBe(204);
    expect(existsSync(join(mediaDir, r.id))).toBe(false);
  });

  it.skipIf(!HAS_FFMPEG)('saves a frame of a video at a moment, once per moment', async () => {
    const big = testConfig({ media: { ...config.media, maxBytes: 50 * 1024 * 1024 } });
    const app2 = await buildApp({ config: big, db, store: new MediaStore(mediaDir, big.media.maxBytes) });
    try {
      const r = await newReport();
      const res = await app2.inject({
        method: 'POST', url: `/api/reports/${r.id}/attachments`, payload: testVideo(),
        headers: { ...auth, 'content-type': 'video/mp4', 'x-file-name': 'clip.mp4' },
      });
      expect(res.statusCode).toBe(201);
      const video = res.json();
      expect(video).toMatchObject({ kind: 'video', mime: 'video/mp4' });
      expect(video.durationMs).toBeGreaterThan(2500);

      const f = await app2.inject({ method: 'POST', url: `/api/attachments/${video.id}/frame`, headers: auth, payload: { at: '0:01.5' } });
      expect(f.statusCode).toBe(200);
      expect(f.json()).toMatchObject({ kind: 'frame', mime: 'image/jpeg', sourceId: video.id, atMs: 1500, fileName: 'clip-0m01s.jpg' });
      const again = await app2.inject({ method: 'POST', url: `/api/attachments/${video.id}/frame`, headers: auth, payload: { at: 1.5 } });
      expect(again.json().id).toBe(f.json().id);
      expect((await app2.inject({ method: 'POST', url: `/api/attachments/${video.id}/frame`, headers: auth, payload: { at: 99 } })).statusCode).toBe(400);
      const img = await app2.inject({ method: 'GET', url: f.json().url });
      expect(img.rawPayload.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    } finally {
      await app2.close();
    }
  });
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reportAttachments, reportJobs } from '../../src/db/schema.js';
import { MEDIA_GONE } from '../../src/domain/jobs.js';
import { purgeClosedMedia } from '../../src/domain/reports.js';
import { buildApp } from '../../src/http/app.js';
import { MediaStore } from '../../src/media/store.js';
import { seedProject, TEST_TOKEN, testConfig, useTestDb } from '../helpers.js';
import { HAS_FFMPEG, headerDuration, liveWebm, PNG, testVideo } from '../media-fixtures.js';

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
const mp3 = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(100)]);

/** An app with a 50 MB limit for videos, on the same media directory. */
async function withBigApp(fn: (app2: FastifyInstance) => Promise<void>) {
  const big = testConfig({ media: { ...config.media, maxBytes: 50 * 1024 * 1024 } });
  const app2 = await buildApp({ config: big, db, store: new MediaStore(mediaDir, big.media.maxBytes) });
  try {
    await fn(app2);
  } finally {
    await app2.close();
  }
}
const uploadTo = (app2: FastifyInstance, reportId: string, body: Buffer, type: string, name: string) =>
  app2.inject({
    method: 'POST', url: `/api/reports/${reportId}/attachments`, payload: body,
    headers: { ...auth, 'content-type': type, 'x-file-name': name },
  });
const frameOf = (app2: FastifyInstance, videoId: string, at: string | number) =>
  app2.inject({ method: 'POST', url: `/api/attachments/${videoId}/frame`, headers: auth, payload: { at } });

/** A saved frame without needing ffmpeg: a photo whose row is turned into a frame. */
async function frameRow(reportId: string) {
  const photo = (await upload(reportId, PNG, 'image/png', 'f.png')).json();
  await db.update(reportAttachments).set({ kind: 'frame', atMs: 1000 }).where(eq(reportAttachments.id, photo.id));
  return photo.id as string;
}

describe('note on a frame', () => {
  it('sets, trims, clears and keeps the note on a closed report', async () => {
    const r = await newReport();
    const id = await frameRow(r.id);
    const set = await call('PATCH', `/api/attachments/${id}`, { note: '  The spinner never stops.  ' });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ id, kind: 'frame', note: 'The spinner never stops.' });
    expect((await call('GET', `/api/reports/${r.id}`)).json().attachments[0].note).toBe('The spinner never stops.');

    await call('PATCH', `/api/reports/${r.id}`, { status: 'done' });
    expect((await call('PATCH', `/api/attachments/${id}`, { note: 'still editable' })).json().note).toBe('still editable');

    expect((await call('PATCH', `/api/attachments/${id}`, { note: '   ' })).json().note).toBeNull();
    await call('PATCH', `/api/attachments/${id}`, { note: 'x' });
    expect((await call('PATCH', `/api/attachments/${id}`, { note: null })).json().note).toBeNull();
  });

  it('refuses a note over 2 000 characters, with NUL, on a non-frame, and a missing attachment', async () => {
    const r = await newReport();
    const id = await frameRow(r.id);
    expect((await call('PATCH', `/api/attachments/${id}`, { note: 'a'.repeat(2000) })).statusCode).toBe(200);
    expect((await call('PATCH', `/api/attachments/${id}`, { note: 'a'.repeat(2001) })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/attachments/${id}`, { note: `a${String.fromCharCode(0)}b` })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/attachments/${id}`, {})).statusCode).toBe(400);
    const photo = (await upload(r.id, PNG, 'image/png', 'p.png')).json();
    expect((await call('PATCH', `/api/attachments/${photo.id}`, { note: 'hi' })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/attachments/00000000-0000-4000-8000-000000000000', { note: 'hi' })).statusCode).toBe(404);
  });
});

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

  it('queues the transcription of audio, never of photos', async () => {
    const r = await newReport();
    const voice = (await upload(r.id, mp3, 'audio/mpeg', 'voice.mp3')).json();
    await upload(r.id, PNG, 'image/png');
    const jobs = await db.select({ attachmentId: reportJobs.attachmentId, status: reportJobs.status }).from(reportJobs);
    expect(jobs).toEqual([{ attachmentId: voice.id, status: 'queued' }]);
  });

  it.skipIf(!HAS_FFMPEG)('queues a video only when it has a sound track', async () => {
    await withBigApp(async (app2) => {
      const r = await newReport();
      const silent = (await uploadTo(app2, r.id, testVideo(), 'video/mp4', 'silent.mp4')).json();
      const webm = liveWebm();
      const sound = webm ? (await uploadTo(app2, r.id, webm, 'video/webm', 'sound.webm')).json() : null;
      const queued = (await db.select({ id: reportJobs.attachmentId }).from(reportJobs)).map((j) => j.id);
      expect(queued).not.toContain(silent.id);
      if (sound) expect(queued).toContain(sound.id);
    });
  });

  it('fails the job of a recording deleted after closing before the worker got to it', async () => {
    const r = await newReport();
    const voice = (await upload(r.id, mp3, 'audio/mpeg', 'voice.mp3')).json();
    await call('PATCH', `/api/reports/${r.id}`, { status: 'done' });
    expect(await purgeClosedMedia(db, store, 0, new Date(Date.now() + 1000))).toBe(1);
    const [job] = await db.select().from(reportJobs).where(eq(reportJobs.attachmentId, voice.id));
    expect(job).toMatchObject({ status: 'failed', error: MEDIA_GONE });
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

  it('refuses an upload to a closed report before reading the body', async () => {
    const r = await newReport();
    await call('PATCH', `/api/reports/${r.id}`, { status: 'done' });
    // Larger than the limit: a 413 would mean the body was streamed first.
    const res = await upload(r.id, Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]), 'image/png');
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/closed/);
    expect(res.headers.connection).toBe('close');
  });

  it('keeps going when one file of a closed report cannot be deleted, and retries it next time', async () => {
    const r = await newReport();
    const a = (await upload(r.id, mp3, 'audio/mpeg', 'a.mp3')).json();
    const b = (await upload(r.id, mp3, 'audio/mpeg', 'b.mp3')).json();
    await call('PATCH', `/api/reports/${r.id}`, { status: 'done' });
    class StuckStore extends MediaStore {
      override async remove(key: string): Promise<void> {
        if (key.includes(a.id)) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
        return super.remove(key);
      }
    }
    const later = new Date(Date.now() + 25 * 3600 * 1000);
    const failed: string[] = [];
    expect(await purgeClosedMedia(db, new StuckStore(mediaDir, 1), 24, later, (_e, id) => failed.push(id))).toBe(1);
    expect(failed).toEqual([a.id]);
    const got = (await call('GET', `/api/reports/${r.id}`)).json();
    expect(got.attachments.find((x: { id: string }) => x.id === b.id).purgedAt).not.toBeNull();
    expect(got.attachments.find((x: { id: string }) => x.id === a.id).purgedAt).toBeNull();
    expect(await purgeClosedMedia(db, store, 24, later)).toBe(1);
  });

  it('never logs the signature of a media link', async () => {
    const lines: string[] = [];
    const prevLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    const logged = await buildApp({ config, db, store, logStream: { write: (msg) => void lines.push(msg) } });
    process.env.LOG_LEVEL = prevLevel;
    try {
      const r = await newReport();
      const a = (await upload(r.id, PNG, 'image/png')).json();
      const sig = new URL(`http://h${a.url}`).searchParams.get('sig')!;
      expect((await logged.inject({ method: 'GET', url: a.url })).statusCode).toBe(200);
      expect(lines.some((l) => l.includes(`/media/${a.id}?exp=`) && l.includes('sig=***'))).toBe(true);
      expect(lines.filter((l) => l.includes(sig))).toEqual([]);
    } finally {
      await logged.close();
    }
  });

  it.skipIf(!HAS_FFMPEG)('gives a browser recording (WebM without a duration) its length and a seek index', async (ctx) => {
    const webm = liveWebm();
    if (!webm) return ctx.skip();
    await withBigApp(async (app2) => {
      const r = await newReport();
      const res = await uploadTo(app2, r.id, webm, 'video/webm', 'screen.webm');
      expect(res.statusCode).toBe(201);
      const video = res.json();
      expect(video).toMatchObject({ kind: 'video', mime: 'video/webm' });
      expect(video.durationMs).toBeGreaterThan(2900);
      expect(video.durationMs).toBeLessThan(3200);
      // The stored file was rewritten with a Duration element (and cues), so browsers can seek in it.
      const stored = join(mediaDir, r.id, `${video.id}.webm`);
      expect(headerDuration(stored)).toBeGreaterThan(2.9);
      expect(statSync(stored).size).toBe(video.size);

      expect((await frameOf(app2, video.id, 1)).statusCode).toBe(200);
      const late = await frameOf(app2, video.id, '1:00');
      expect(late.statusCode).toBe(400);
      expect(late.json().message).toMatch(/past its end/);
      const absurd = await frameOf(app2, video.id, '99999999');
      expect(absurd.statusCode).toBe(400);
      expect(absurd.json().message).toMatch(/past 24:00:00/);
    });
  });

  it.skipIf(!HAS_FFMPEG)('saves one frame when the same moment is asked for several times at once', async () => {
    await withBigApp(async (app2) => {
      const r = await newReport();
      const video = (await uploadTo(app2, r.id, testVideo(), 'video/mp4', 'clip.mp4')).json();
      // Open enough pool connections first, so the requests really overlap instead of waiting for a connection.
      await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`SELECT pg_sleep(0.05)`)));
      const res = await Promise.all([1, 2, 3].map(() => frameOf(app2, video.id, '0:01')));
      expect(res.map((x) => x.statusCode)).toEqual([200, 200, 200]);
      expect(new Set(res.map((x) => x.json().id)).size).toBe(1);
      const got = (await call('GET', `/api/reports/${r.id}`)).json();
      expect(got.attachments.filter((a: { kind: string }) => a.kind === 'frame')).toHaveLength(1);
      expect(readdirSync(join(mediaDir, r.id))).toHaveLength(2);
    });
  });

  it.skipIf(!HAS_FFMPEG)('does not show ffmpeg output (server paths) when a video cannot be decoded', async () => {
    await withBigApp(async (app2) => {
      const r = await newReport();
      const fake = Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypisom', 'latin1'), Buffer.alloc(2000, 7)]);
      const video = (await uploadTo(app2, r.id, fake, 'video/mp4', 'broken.mp4')).json();
      expect(video.kind).toBe('video');
      const res = await frameOf(app2, video.id, 1);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/^could not take a frame at 1\.0 s: /);
      expect(res.json().message).not.toContain(mediaDir);
      expect(res.json().message).not.toMatch(/exited with/);
    });
  });
});

describe('reports without a project, and Keep media', () => {
  it('creates a report with no fields, titled with the date and time', async () => {
    const bare = await app.inject({ method: 'POST', url: '/api/reports', headers: auth });
    expect(bare.statusCode).toBe(201);
    expect(bare.json()).toMatchObject({ projectId: null, keepMedia: false, body: '' });
    expect(bare.json().title).toMatch(/^Report \d{1,2}\. \d{1,2}\. \d{4} \d{2}:\d{2}$/);
    expect((await call('POST', '/api/reports', {})).json().title).toMatch(/^Report /);
    expect((await call('POST', '/api/reports', { projectId: null, title: 'Standup' })).json()).toMatchObject({ projectId: null, title: 'Standup' });
  });

  it('filters and counts reports without a project, and takes the project away with null', async () => {
    const none = (await call('POST', '/api/reports', { title: 'Meeting' })).json();
    const demo = await newReport();
    expect((await call('GET', '/api/reports?project=none')).json()).toMatchObject({ total: 1, items: [{ id: none.id, projectId: null }] });
    expect((await call('GET', '/api/reports')).json().total).toBe(2);
    expect((await call('GET', '/api/reports/counts')).json()).toEqual({ demo: 1, none: 1 });
    expect((await call('PATCH', `/api/reports/${demo.id}`, { projectId: null })).json()).toMatchObject({ projectId: null, version: 2 });
    expect((await call('GET', '/api/reports/counts')).json()).toEqual({ none: 2 });
    expect((await call('PATCH', `/api/reports/${none.id}`, { projectId: 'demo' })).json().projectId).toBe('demo');
    expect((await call('PATCH', `/api/reports/${none.id}`, { projectId: 'global' })).statusCode).toBe(400);
    expect((await call('POST', '/api/projects', { id: 'none', name: 'None' })).statusCode).toBe(400);
  });

  it('turns Keep media on and off, says how long closed media wait, and purges once it is off', async () => {
    const r = await newReport();
    expect((await call('PATCH', `/api/reports/${r.id}`, { keepMedia: true })).json()).toMatchObject({ keepMedia: true });
    expect((await call('GET', `/api/reports/${r.id}`)).json()).toMatchObject({ keepMedia: true, purgeAfterHours: 24 });
    expect((await call('PATCH', `/api/reports/${r.id}`, { keepMedia: 'yes' })).statusCode).toBe(400);
    const voice = (await upload(r.id, mp3, 'audio/mpeg', 'voice.mp3')).json();
    await call('PATCH', `/api/reports/${r.id}`, { status: 'done' });
    expect(await purgeClosedMedia(db, store, 0, new Date(Date.now() + 1000))).toBe(0);
    await call('PATCH', `/api/reports/${r.id}`, { keepMedia: false });
    expect(await purgeClosedMedia(db, store, 0, new Date(Date.now() + 1000))).toBe(1);
    const audio = (await call('GET', `/api/reports/${r.id}`)).json().attachments.find((a: { id: string }) => a.id === voice.id);
    expect(audio.url).toBeNull();
  });
});

describe('media storage that is missing or not writable', () => {
  it('startup clears temporary files left by interrupted uploads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabula-leftovers-'));
    mkdirSync(join(dir, '.tmp'));
    writeFileSync(join(dir, '.tmp', 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6'), 'half an upload');
    expect(await new MediaStore(dir, 1024).startup()).toBeNull();
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it('answers uploads with a clear 503 while the rest of Tabula keeps working', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tabula-broken-')), 'not-a-directory');
    writeFileSync(file, '');
    const broken = new MediaStore(join(file, 'media'), config.media.maxBytes);
    expect(await broken.startup()).toMatch(/^E[A-Z]+: /);
    const app2 = await buildApp({ config, db, store: broken });
    try {
      expect((await app2.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      const created = await app2.inject({ method: 'POST', url: '/api/reports', headers: auth, payload: { projectId: 'demo', body: 'x' } });
      expect(created.statusCode).toBe(201);
      const res = await app2.inject({
        method: 'POST', url: `/api/reports/${created.json().id}/attachments`, payload: PNG,
        headers: { ...auth, 'content-type': 'image/png' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'unavailable', message: expect.stringMatching(/^media storage is not available/) });
      expect(res.json().message).not.toContain(file);
      expect((await app2.inject({ method: 'GET', url: '/api/reports?project=demo', headers: auth })).json().total).toBe(1);
    } finally {
      await app2.close();
    }
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reportJobs, workers } from '../../src/db/schema.js';
import { buildApp } from '../../src/http/app.js';
import { MediaStore } from '../../src/media/store.js';
import { seedProject, TEST_TOKEN, TEST_WORKER_TOKEN, testConfig, useTestDb } from '../helpers.js';
import { silentWav } from '../media-fixtures.js';

const db = useTestDb();
const mediaDir = mkdtempSync(join(tmpdir(), 'tabula-worker-media-'));
const config = testConfig({ media: { dir: mediaDir, maxBytes: 10 * 1024 * 1024, purgeAfterHours: 24, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } });
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config, db, store: new MediaStore(mediaDir, config.media.maxBytes) });
});
afterAll(() => app.close());
beforeEach(() => seedProject(db, 'demo'));

const main = { authorization: `Bearer ${TEST_TOKEN}` };
const worker = { authorization: `Bearer ${TEST_WORKER_TOKEN}`, 'x-tabula-worker': 'Studio-PC', 'x-tabula-version': '1.2.0' };
const asWorker = (method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url: `/api/worker${url}`, headers: worker, ...(payload && { payload }) });
const asUser = (method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url: `/api${url}`, headers: main, ...(payload && { payload }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function recordedReport() {
  const report = (await asUser('POST', '/reports', { projectId: 'demo', body: 'Player freezes' })).json();
  const res = await app.inject({
    method: 'POST', url: `/api/reports/${report.id}/attachments`, payload: silentWav(2),
    headers: { ...main, 'content-type': 'audio/wav', 'x-file-name': 'voice.wav' },
  });
  expect(res.statusCode).toBe(201);
  return { report, audio: res.json() };
}

const claim = async () => {
  const res = await asWorker('POST', '/jobs/claim', { wait: 0 });
  expect(res.statusCode).toBe(200);
  return res.json();
};

/** A second app on a real socket: hang-ups and shutdown need a connection, which inject() does not have. */
async function listening() {
  const live = await buildApp({ config, db, store: new MediaStore(mediaDir, config.media.maxBytes) });
  const base = await live.listen({ port: 0, host: '127.0.0.1' });
  const longPoll = (wait: number, signal?: AbortSignal) =>
    fetch(`${base}/api/worker/jobs/claim`, {
      method: 'POST', headers: { ...worker, 'content-type': 'application/json' }, body: JSON.stringify({ wait }), signal,
    });
  return { live, longPoll };
}

describe('worker API', () => {
  it('opens only with the worker token, and the worker token opens nothing else', async () => {
    expect((await asWorker('GET', '/ping')).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/worker/ping', headers: main })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/worker/ping' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: worker })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/transcription/status', headers: worker })).statusCode).toBe(401);
    const mcp = await app.inject({
      method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: { ...worker, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    });
    expect(mcp.statusCode).toBe(401);
  });

  it('answers 503 when no worker token is configured', async () => {
    const off = await buildApp({ config: testConfig({ workerToken: undefined }), db });
    try {
      const res = await off.inject({ method: 'GET', url: '/api/worker/ping', headers: worker });
      expect(res.statusCode).toBe(503);
      expect(res.json().message).toMatch(/TABULA_WORKER_TOKEN/);
    } finally {
      await off.close();
    }
  });

  it("reports the queue and this computer's worker without counting as a sign of life", async () => {
    await recordedReport();
    await recordedReport();
    expect((await asWorker('GET', '/queue')).json()).toEqual({ queued: 2, running: 0, worker: null });
    expect(await db.select().from(workers)).toEqual([]);

    await claim(); // a real worker call: studio-pc is seen now
    const [seen] = await db.select().from(workers);
    await sleep(30);
    const res = await asWorker('GET', '/queue');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ queued: 1, running: 1, worker: { name: 'studio-pc', last_seen: seen!.lastSeenAt.toISOString() } });
    const [after] = await db.select().from(workers);
    expect(after!.lastSeenAt.getTime()).toBe(seen!.lastSeenAt.getTime());

    // Another computer's name: no record of it, and asking creates none.
    const other = await app.inject({ method: 'GET', url: '/api/worker/queue', headers: { ...worker, 'x-tabula-worker': 'Other-PC' } });
    expect(other.json()).toEqual({ queued: 1, running: 1, worker: null });
    expect(await db.select().from(workers)).toHaveLength(1);
  });

  it('opens /queue only with the worker token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/worker/queue', headers: main })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/worker/queue' })).statusCode).toBe(401);
    const off = await buildApp({ config: testConfig({ workerToken: undefined }), db });
    try {
      expect((await off.inject({ method: 'GET', url: '/api/worker/queue', headers: worker })).statusCode).toBe(503);
    } finally {
      await off.close();
    }
  });

  it('hands out a job with a signed link, takes the transcript and shows it to the UI', async () => {
    const { report, audio } = await recordedReport();
    expect(audio.transcript).toMatchObject({ status: 'queued', attempts: 0 });
    const job = await claim();
    expect(job).toMatchObject({
      attempt: 1, kind: 'transcribe',
      attachment: { id: audio.id, kind: 'audio', mime: 'audio/wav', file_name: 'voice.wav' },
      report: { id: report.id, project: 'demo', title: 'Player freezes' },
    });
    expect(job.media_path).toMatch(/^\/media\/[0-9a-f-]{36}\?exp=\d+&sig=/);
    const media = await app.inject({ method: 'GET', url: job.media_path });
    expect(media.statusCode).toBe(200);
    expect(media.rawPayload.equals(silentWav(2))).toBe(true);
    expect((await asWorker('POST', '/jobs/claim', { wait: 0 })).statusCode).toBe(204);

    expect((await asWorker('POST', `/jobs/${job.id}/heartbeat`, { lease: job.lease })).json().lease_until).toMatch(/^\d{4}-/);
    const done = await asWorker('POST', `/jobs/${job.id}/complete`, {
      lease: job.lease, language: 'sk', model: 'large-v3', duration_ms: 2000,
      segments: [{ start_ms: 0, end_ms: 1200, text: ' Prehrávač zamrzne. ' }, { start_ms: 1300, end_ms: 1900, text: 'Tu.' }],
    });
    expect(done.json()).toEqual({ ok: true, segments: 2 });
    const got = (await asUser('GET', `/reports/${report.id}`)).json();
    expect(got.attachments[0].transcript).toMatchObject({
      status: 'done', language: 'sk',
      segments: [{ start_ms: 0, end_ms: 1200, text: 'Prehrávač zamrzne.' }, { start_ms: 1300, end_ms: 1900, text: 'Tu.' }],
    });
    // ffprobe (where installed) measured 2 s at upload; otherwise the worker's value fills the gap.
    expect(got.attachments[0].durationMs).toBe(2000);
    expect((await asUser('GET', '/reports?q=zamrz')).json().total).toBe(1);
    const again = await asWorker('POST', `/jobs/${job.id}/complete`, { lease: job.lease, language: 'sk', model: 'large-v3', duration_ms: 2000, segments: [] });
    expect(again.statusCode).toBe(409);
  });

  it('holds a claim open and answers as soon as a recording arrives', async () => {
    const started = Date.now();
    const pending = asWorker('POST', '/jobs/claim', { wait: 10 });
    await new Promise((r) => setTimeout(r, 300));
    const { audio } = await recordedReport();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json().attachment.id).toBe(audio.id);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('does not hand a job to a worker that hung up while its claim waited', async () => {
    const { live, longPoll } = await listening();
    try {
      const { audio } = await recordedReport();
      const job = () => db.select().from(reportJobs).where(eq(reportJobs.attachmentId, audio.id)).then((r) => r[0]!);
      // Not due yet: the waiting claim finds nothing and sleeps.
      await db.update(reportJobs).set({ runAfter: new Date(Date.now() + 3_600_000) }).where(eq(reportJobs.attachmentId, audio.id));
      const hangUp = new AbortController();
      const pending = longPoll(10, hangUp.signal).catch(() => null);
      await sleep(300);
      // Due now, without waking the claim: only the hang-up wakes it, and it must not take the job for nobody.
      await db.update(reportJobs).set({ runAfter: new Date(0) }).where(eq(reportJobs.attachmentId, audio.id));
      hangUp.abort();
      await pending;
      await sleep(300);
      expect(await job()).toMatchObject({ status: 'queued', attempts: 0 });
      expect(await claim()).toMatchObject({ attempt: 1 });
    } finally {
      await live.close();
    }
  });

  it('gives the attempt back when the worker hangs up while its job is being claimed', async () => {
    const { live, longPoll } = await listening();
    let unlock!: () => void;
    let locking: Promise<void> | undefined;
    try {
      const { audio } = await recordedReport();
      // Holds the claim inside claimJob (its lease sweep waits for this lock) while the worker hangs up.
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      locking = db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE report_jobs IN SHARE MODE`);
        locked();
        await new Promise<void>((r) => (unlock = r));
      });
      await isLocked;
      const hangUp = new AbortController();
      const pending = longPoll(0, hangUp.signal).catch(() => null);
      await sleep(300);
      hangUp.abort();
      await pending;
      await sleep(300);
      unlock();
      await locking;
      await sleep(300);
      const [job] = await db.select().from(reportJobs).where(eq(reportJobs.attachmentId, audio.id));
      expect(job).toMatchObject({ status: 'queued', attempts: 0, leaseId: null });
    } finally {
      unlock?.();
      await locking;
      await live.close();
    }
  });

  it('accepts a claim without a body', async () => {
    const { audio } = await recordedReport();
    const res = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: worker });
    expect(res.statusCode).toBe(200);
    expect(res.json().attachment.id).toBe(audio.id);
  });

  it('keeps transcript text out of the log when storing it fails', async () => {
    const lines: string[] = [];
    const logged = await buildApp({ config, db, logStream: { write: (msg) => void lines.push(msg) } });
    await recordedReport();
    const job = await claim();
    // A real query error from the transcript insert: Postgres refuses every new row.
    await db.execute(sql`ALTER TABLE report_transcripts ADD CONSTRAINT refuse_all CHECK (false) NOT VALID`);
    try {
      const res = await logged.inject({
        method: 'POST', url: `/api/worker/jobs/${job.id}/complete`, headers: worker,
        payload: { lease: job.lease, language: 'sk', model: 'large-v3', duration_ms: null, segments: [{ start_ms: 0, end_ms: 900, text: 'Tajné slovo v prepise' }] },
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('Tajné');
    } finally {
      await db.execute(sql`ALTER TABLE report_transcripts DROP CONSTRAINT refuse_all`);
      await logged.close();
    }
    const log = lines.join('');
    expect(log).toContain('Failed query');
    expect(log).toContain('refuse_all');
    expect(log).not.toContain('Tajn');
  });

  it('answers waiting claims with "no job" at once when the server shuts down', async () => {
    const { live, longPoll } = await listening();
    const pending = longPoll(10);
    await sleep(300);
    const started = Date.now();
    await live.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await pending).status).toBe(204);
  });

  it('retries a failed job, fails it after three attempts, and lets the user try again', async () => {
    const { audio } = await recordedReport();
    for (let i = 1; i <= 3; i++) {
      // The back-off would hold the job for minutes: make it due now.
      await db.update(reportJobs).set({ runAfter: new Date(0) }).where(eq(reportJobs.attachmentId, audio.id));
      const job = await claim();
      expect(job.attempt).toBe(i);
      const failed = (await asWorker('POST', `/jobs/${job.id}/fail`, { lease: job.lease, error: `ffmpeg exited with 1 (try ${i})` })).json();
      expect(failed.status).toBe(i < 3 ? 'queued' : 'failed');
      expect(failed.retry_at === null).toBe(i === 3);
    }
    const report = (await asUser('GET', `/reports/${audio.reportId}`)).json();
    expect(report.attachments[0].transcript).toMatchObject({ status: 'failed', attempts: 3, error: 'ffmpeg exited with 1 (try 3)' });
    expect((await asUser('GET', '/transcription/status')).json()).toMatchObject({ failed: 1, queued: 0 });
    const retried = await asUser('POST', `/attachments/${audio.id}/transcript/retry`);
    expect(retried.json()).toMatchObject({ status: 'queued', attempts: 0, error: null });
    expect((await asUser('POST', `/attachments/${audio.id}/transcript/retry`)).statusCode).toBe(409);
  });

  it('takes a released job back without counting the attempt, and refuses a stale lease', async () => {
    await recordedReport();
    const job = await claim();
    expect((await asWorker('POST', `/jobs/${job.id}/release`, { lease: job.lease })).statusCode).toBe(204);
    const again = await claim();
    expect(again).toMatchObject({ id: job.id, attempt: 1 });
    expect((await asWorker('POST', `/jobs/${job.id}/heartbeat`, { lease: job.lease })).statusCode).toBe(409);
    expect((await asWorker('POST', `/jobs/${job.id}/heartbeat`, { lease: 'not-a-uuid' })).statusCode).toBe(400);
  });

  it('refuses malformed transcripts', async () => {
    await recordedReport();
    const job = await claim();
    const send = (body: object) => asWorker('POST', `/jobs/${job.id}/complete`, { lease: job.lease, language: 'sk', model: 'large-v3', duration_ms: null, ...body });
    expect((await send({ segments: [{ start_ms: 5, end_ms: 1, text: 'x' }] })).statusCode).toBe(400);
    expect((await send({ segments: [{ start_ms: 0, end_ms: 1, text: `a${String.fromCharCode(0)}b` }] })).statusCode).toBe(400);
    expect((await send({ segments: [{ start_ms: 0, end_ms: 1 }] })).statusCode).toBe(400);
    expect((await send({ language: 'sk; drop', segments: [] })).statusCode).toBe(400);
    expect((await send({ segments: [] })).statusCode).toBe(200);
  });

  it('reports whether transcription is enabled on this server', async () => {
    expect((await asUser('GET', '/transcription/status')).json().enabled).toBe(true);
    const off = await buildApp({ config: testConfig({ workerToken: undefined }), db });
    try {
      const res = await off.inject({ method: 'GET', url: '/api/transcription/status', headers: main });
      expect(res.json()).toMatchObject({ enabled: false, queued: 0 });
    } finally {
      await off.close();
    }
  });

  it('remembers when and which worker was last seen', async () => {
    await asWorker('GET', '/ping');
    const s = (await asUser('GET', '/transcription/status')).json();
    expect(s.workers[0]).toMatchObject({ name: 'studio-pc', version: '1.2.0' });
    expect(Date.now() - Date.parse(s.lastSeenAt)).toBeLessThan(10_000);
  });
});

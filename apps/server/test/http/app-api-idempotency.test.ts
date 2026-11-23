import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepAuth } from '../../src/auth/sweep.js';
import { appIdempotency, oauthConnections, reportAttachments, thoughts } from '../../src/db/schema.js';
import { buildApp } from '../../src/http/app.js';
import { fingerprintOf } from '../../src/http/app-idempotency.js';
import { MediaStore } from '../../src/media/store.js';
import { issueTestAccessToken, seedProject, TEST_APP_TOKEN, testConfig, useTestAppToken, useTestDb } from '../helpers.js';

const db = useTestDb();
useTestAppToken(db);
const mediaDir = mkdtempSync(join(tmpdir(), 'tabula-idempotency-media-'));
const config = testConfig({ media: { dir: mediaDir, maxBytes: 2 * 1024 * 1024, purgeAfterHours: 24, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } });
let app: FastifyInstance;
let port = 0;
beforeAll(async () => {
  app = await buildApp({ config, db, store: new MediaStore(mediaDir, config.media.maxBytes) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});
afterAll(() => app.close());
beforeEach(() => seedProject(db, 'beta'));

const thought = { title: 'Garden', body: 'Plant garlic in October.' };
const postThought = (payload: unknown, key?: string, token = TEST_APP_TOKEN) =>
  app.inject({
    method: 'POST', url: '/app-api/v1/thoughts', payload: payload as object,
    headers: { authorization: `Bearer ${token}`, ...(key !== undefined && { 'idempotency-key': key }) },
  });
const rows = () => db.select().from(appIdempotency);
const klaraId = async () => (await db.select({ id: oauthConnections.id }).from(oauthConnections).where(eq(oauthConnections.name, 'klara')))[0]!.id;

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached within 10 s');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('Idempotency-Key on JSON writes', () => {
  it('answers a repeat with the stored response and Idempotent-Replayed, and writes once', async () => {
    const first = await postThought(thought, 'key-1');
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const again = await postThought(thought, 'key-1');
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await db.select().from(thoughts)).toHaveLength(1);
    expect(await rows()).toMatchObject([{ key: 'key-1', state: 'done', responseStatus: 201 }]);
  });

  it('refuses another request under a used key with 422 idempotency_key_reused', async () => {
    await postThought(thought, 'key-1');
    const other = await postThought({ ...thought, body: 'Plant tulips.' }, 'key-1');
    expect(other.statusCode).toBe(422);
    expect(other.json()).toEqual({ error: 'idempotency_key_reused', message: expect.any(String) });
    expect(await db.select().from(thoughts)).toHaveLength(1);
  });

  it('frees the key after a refused request, so it runs again and a corrected one goes through', async () => {
    expect((await postThought({ title: '', body: 'x' }, 'key-1')).statusCode).toBe(400);
    expect(await rows()).toEqual([]);
    expect((await postThought({ title: '', body: 'x' }, 'key-1')).statusCode).toBe(400);
    const good = await postThought(thought, 'key-1');
    expect(good.statusCode).toBe(201);
    expect(good.headers['idempotent-replayed']).toBeUndefined();
  });

  it('keeps keys apart per connection', async () => {
    const other = await issueTestAccessToken(db, { resource: 'app', name: 'klara-2' });
    const a = await postThought(thought, 'shared');
    const b = await postThought({ ...thought, body: 'Another text.' }, 'shared', other.value);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(b.json().id).not.toBe(a.json().id);
    expect(await db.select().from(thoughts)).toHaveLength(2);
  });

  it('answers 409 request_in_progress while the same request still runs', async () => {
    // A recent pending row of exactly this request: what a run in another process leaves while it works.
    const fingerprint = fingerprintOf(['POST', '/app-api/v1/thoughts', JSON.stringify(thought)]);
    await db.insert(appIdempotency).values({ connectionId: await klaraId(), key: 'key-1', fingerprint, state: 'pending' });
    const res = await postThought(thought, 'key-1');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'request_in_progress', message: expect.any(String) });
    // A different request under that key is told so at once, whatever the state.
    expect((await postThought({ ...thought, body: 'Plant tulips.' }, 'key-1')).statusCode).toBe(422);
    expect(await db.select().from(thoughts)).toHaveLength(0);
  });

  it('writes once when the same request arrives several times at once', async () => {
    // Open the pool's connections first; otherwise the requests wait for new connections one by one and never overlap.
    await Promise.all(Array.from({ length: 8 }, () => db.execute(sql`SELECT pg_sleep(0.05)`)));
    const answers = await Promise.all(Array.from({ length: 6 }, () => postThought(thought, 'burst')));
    expect(answers.every((a) => a.statusCode === 201 || a.statusCode === 409)).toBe(true);
    // At least one arrived while the first still ran: the requests did overlap.
    expect(answers.some((a) => a.statusCode === 409)).toBe(true);
    const fresh = answers.filter((a) => a.statusCode === 201 && a.headers['idempotent-replayed'] === undefined);
    expect(fresh).toHaveLength(1);
    for (const a of answers.filter((x) => x.statusCode === 201)) expect(a.json()).toEqual(fresh[0]!.json());
    expect(await db.select().from(thoughts)).toHaveLength(1);
    expect(await rows()).toMatchObject([{ key: 'burst', state: 'done', responseStatus: 201 }]);
  });

  it('treats a pending key older than an hour as absent', async () => {
    await db.insert(appIdempotency).values({
      connectionId: await klaraId(), key: 'key-1', fingerprint: 'left-by-a-crashed-process', state: 'pending', createdAt: new Date(Date.now() - 2 * 3600_000),
    });
    const res = await postThought(thought, 'key-1');
    expect(res.statusCode).toBe(201);
    expect(await rows()).toMatchObject([{ key: 'key-1', state: 'done', responseStatus: 201 }]);
  });

  it('refuses a key over 200 characters with 400 validation_failed and writes nothing', async () => {
    const res = await postThought(thought, 'k'.repeat(201));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_failed', issues: [{ path: 'Idempotency-Key' }] });
    expect(await db.select().from(thoughts)).toHaveLength(0);
  });

  it('is swept after 7 days', async () => {
    const now = new Date();
    const day = 24 * 3600_000;
    const connectionId = await klaraId();
    await db.insert(appIdempotency).values([
      { connectionId, key: 'old', fingerprint: 'f', state: 'done', responseStatus: 201, responseBody: { id: 'x' }, createdAt: new Date(now.getTime() - 8 * day) },
      { connectionId, key: 'recent', fingerprint: 'f', state: 'done', responseStatus: 201, responseBody: { id: 'y' }, createdAt: new Date(now.getTime() - 6 * day) },
    ]);
    expect((await sweepAuth(db, now)).idempotency).toBe(1);
    expect((await rows()).map((r) => r.key)).toEqual(['recent']);
  });
});

describe('Idempotency-Key on uploads', () => {
  /** An MP3 as its first bytes say; built from numbers, so no escape sequence is typed. */
  const mp3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(200_000)]);
  const newReport = async () =>
    (await app.inject({ method: 'POST', url: '/app-api/v1/reports', headers: { authorization: `Bearer ${TEST_APP_TOKEN}` }, payload: { project: 'beta' } })).json().id as string;
  const headersFor = (key: string) => ({
    authorization: `Bearer ${TEST_APP_TOKEN}`, 'content-type': 'audio/mpeg', 'content-length': String(mp3.length), 'x-filename': 'voice.mp3', 'idempotency-key': key,
  });
  /** An upload over a real connection whose body is sent only as far as the test says. */
  function slowUpload(reportId: string, key: string) {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: `/app-api/v1/reports/${reportId}/attachments`, headers: headersFor(key) });
    const answered = new Promise<{ status: number; body: string }>((resolve, reject) => {
      req.on('response', (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on('error', reject);
    });
    req.write(mp3.subarray(0, 1000));
    return { req, answered };
  }
  const injectUpload = (reportId: string, key: string) =>
    app.inject({ method: 'POST', url: `/app-api/v1/reports/${reportId}/attachments`, headers: headersFor(key), payload: mp3 });

  it('answers 409 request_in_progress while the same upload still runs, then replays it', async () => {
    const r = await newReport();
    const slow = slowUpload(r, 'upload-1');
    await waitFor(async () => (await rows()).length === 1);
    const second = await injectUpload(r, 'upload-1');
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'request_in_progress', message: expect.any(String) });
    expect(second.headers.connection).toBe('close');
    slow.req.end(mp3.subarray(1000));
    const first = await slow.answered;
    expect(first.status).toBe(201);
    const third = await injectUpload(r, 'upload-1');
    expect(third.statusCode).toBe(201);
    expect(third.headers['idempotent-replayed']).toBe('true');
    expect(third.json()).toEqual(JSON.parse(first.body));
    expect(await db.select().from(reportAttachments)).toHaveLength(1);
  });

  it('frees the key when the upload breaks off, so the retry runs', async () => {
    const r = await newReport();
    const slow = slowUpload(r, 'upload-2');
    slow.answered.catch(() => {});
    await waitFor(async () => (await rows()).length === 1);
    slow.req.destroy();
    await waitFor(async () => (await rows()).length === 0);
    const retry = await injectUpload(r, 'upload-2');
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(await db.select().from(reportAttachments)).toHaveLength(1);
  });
});

describe('the log', () => {
  it('never holds the key, the body or the token', async () => {
    const logs: string[] = [];
    const prevLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    const logged = await buildApp({ config, db, logStream: { write: (m) => void logs.push(m) } });
    process.env.LOG_LEVEL = prevLevel;
    try {
      const headers = { authorization: `Bearer ${TEST_APP_TOKEN}`, 'idempotency-key': 'secret-key-0123456789' };
      await logged.inject({ method: 'POST', url: '/app-api/v1/thoughts', headers, payload: { title: 'T', body: 'SECRET-BODY-TEXT' } });
      await logged.inject({ method: 'POST', url: '/app-api/v1/thoughts', headers, payload: { title: 'T', body: 'OTHER-SECRET-TEXT' } });
      expect(logs.length).toBeGreaterThan(0);
      for (const secret of ['secret-key-0123456789', 'SECRET-BODY-TEXT', 'OTHER-SECRET-TEXT', TEST_APP_TOKEN]) expect(logs.join()).not.toContain(secret);
    } finally {
      await logged.close();
    }
  });
});

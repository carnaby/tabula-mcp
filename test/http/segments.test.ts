import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Diarization, reportAttachments, reports, type TranscriptSegment } from '../../src/db/schema.js';
import { claimJob, completeJob } from '../../src/domain/jobs.js';
import { buildApp } from '../../src/http/app.js';
import { MediaStore } from '../../src/media/store.js';
import { seedProject, TEST_TOKEN, testConfig, useTestDb } from '../helpers.js';
import { silentWav } from '../media-fixtures.js';

const db = useTestDb();
const mediaDir = mkdtempSync(join(tmpdir(), 'tabula-segments-media-'));
const config = testConfig({ media: { dir: mediaDir, maxBytes: 10 * 1024 * 1024, purgeAfterHours: 24, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } });
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config, db, store: new MediaStore(mediaDir, config.media.maxBytes) });
});
afterAll(() => app.close());
beforeEach(() => seedProject(db, 'demo'));

const auth = { authorization: `Bearer ${TEST_TOKEN}` };
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url: `/api${url}`, headers: auth, ...(payload && { payload }) });
const uploadWav = (reportId: string, name: string) =>
  app.inject({
    method: 'POST', url: `/api/reports/${reportId}/attachments`, payload: silentWav(2),
    headers: { ...auth, 'content-type': 'audio/wav', 'x-file-name': name },
  });
const edit = (id: string, index: number | string, body: object) => call('PATCH', `/attachments/${id}/segments/${index}`, body);

const SPOKEN: TranscriptSegment[] = [
  { start_ms: 0, end_ms: 900, text: 'Kde je tlačidlo uložiť?', speaker: 'S1' },
  { start_ms: 1000, end_ms: 1900, text: 'Vpravo hore.', speaker: 'S2' },
];
const PLAIN: TranscriptSegment[] = [
  { start_ms: 0, end_ms: 900, text: 'Kde je tlačidlo uložiť?' },
  { start_ms: 1000, end_ms: 1900, text: 'Vpravo hore.' },
];
const PYANNOTE: Diarization = { model: 'pyannote/speaker-diarization-community-1', speakers: 2 };

/** A report without a project whose voice note the worker transcribed. */
async function spoken(segments = SPOKEN, diarization: Diarization | null = PYANNOTE) {
  const report = (await call('POST', '/reports', { title: 'Meeting' })).json();
  const res = await uploadWav(report.id, 'voice.wav');
  expect(res.statusCode).toBe(201);
  const c = (await claimJob(db, 'pc'))!;
  await completeJob(db, c.job.id, c.job.leaseId!, { language: 'sk', model: 'large-v3', durationMs: 2000, segments, diarization });
  return { report, audio: res.json() };
}

describe('editing a transcript line', () => {
  it('answers 409 while the recording is transcribed again, and writes nothing', async () => {
    const { audio } = await spoken();
    expect((await call('POST', `/attachments/${audio.id}/transcribe`)).statusCode).toBe(200);
    const res = await edit(audio.id, 0, { text: 'Kde je tlačidlo Uložiť?', expected: { text: 'Kde je tlačidlo uložiť?', speaker: 'S1' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/being transcribed again/);
    expect(res.json()).not.toHaveProperty('current');
  });

  it('saves the text and the speaker, answers with the whole transcript, and restores the original', async () => {
    const { audio } = await spoken();
    const res = await edit(audio.id, 0, { text: 'Kde je tlačidlo Uložiť?', speaker: 'S2', expected: { text: 'Kde je tlačidlo uložiť?', speaker: 'S1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'done',
      segments: [
        { text: 'Kde je tlačidlo Uložiť?', speaker: 'S2', edit: { by: 'user', original: { text: 'Kde je tlačidlo uložiť?', speaker: 'S1' } } },
        { text: 'Vpravo hore.' },
      ],
    });
    const back = await call('POST', `/attachments/${audio.id}/segments/0/restore`);
    expect(back.statusCode).toBe(200);
    expect(back.json().segments[0]).toEqual(SPOKEN[0]);
  });

  it('refuses bad input with 400, and a changed line with 409 and the current line', async () => {
    const { audio } = await spoken();
    const expected = { text: 'Kde je tlačidlo uložiť?', speaker: 'S1' };
    expect((await edit(audio.id, 0, { text: ' ', expected })).statusCode).toBe(400);
    expect((await edit(audio.id, 0, { text: 'x'.repeat(2001), expected })).statusCode).toBe(400);
    expect((await edit(audio.id, 0, { speaker: 'S3', expected })).statusCode).toBe(400);
    expect((await edit(audio.id, 0, { text: 'x' })).statusCode).toBe(400);
    expect((await edit(audio.id, -1, { text: 'x', expected })).statusCode).toBe(400);
    for (const bad of ['-1', 'x', '%20', '0x1', '1e0', '1.5']) {
      expect((await edit(audio.id, bad, { text: 'x', expected })).statusCode).toBe(400);
      expect((await call('POST', `/attachments/${audio.id}/segments/${bad}/restore`)).statusCode).toBe(400);
    }
    expect((await edit(audio.id, 0, { text: 'Kde je tlačidlo Uložiť?', expected })).statusCode).toBe(200);
    const stale = await edit(audio.id, 0, { text: 'Kde je to tlačidlo?', expected });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: 'conflict', message: expect.stringMatching(/changed meanwhile/), current: { text: 'Kde je tlačidlo Uložiť?', edit: { by: 'user' } },
    });
  });

  it('answers 404 for a line out of range, a recording not transcribed yet and a missing attachment', async () => {
    const { report, audio } = await spoken();
    const expected = { text: 'x', speaker: null };
    expect((await edit(audio.id, 2, { text: 'y', expected })).statusCode).toBe(404);
    expect((await call('POST', `/attachments/${audio.id}/segments/9/restore`)).statusCode).toBe(404);
    const waiting = await uploadWav(report.id, 'later.wav');
    expect((await edit(waiting.json().id, 0, { text: 'y', expected })).statusCode).toBe(404);
    expect((await edit('00000000-0000-4000-8000-000000000000', 0, { text: 'y', expected })).statusCode).toBe(404);
  });

  it('edits a closed report whose recording was deleted, and refuses a speaker without speaker recognition', async () => {
    const { report, audio } = await spoken(PLAIN, null);
    await db.update(reports).set({ status: 'done', closedAt: new Date() }).where(eq(reports.id, report.id));
    await db.update(reportAttachments).set({ purgedAt: new Date() }).where(eq(reportAttachments.id, audio.id));
    const ok = await edit(audio.id, 0, { text: 'Kde je tlačidlo Uložiť?', expected: { text: 'Kde je tlačidlo uložiť?', speaker: null } });
    expect(ok.statusCode).toBe(200);
    const r = await edit(audio.id, 1, { speaker: 'S1', expected: { text: 'Vpravo hore.' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toMatch(/the recording has no speakers/);
  });
});

import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { type Diarization, reportAttachments } from '../../src/db/schema.js';
import { claimJob, completeJob } from '../../src/domain/jobs.js';
import { buildApp } from '../../src/http/app.js';
import { MediaStore } from '../../src/media/store.js';
import { seedProject, TEST_TOKEN, testConfig, useTestDb } from '../helpers.js';
import { HAS_FFMPEG, PNG, silentWav, testVideo } from '../media-fixtures.js';

const db = useTestDb();
const mediaDir = mkdtempSync(join(tmpdir(), 'tabula-mcp-media-'));
const config = testConfig({ media: { dir: mediaDir, maxBytes: 50 * 1024 * 1024, purgeAfterHours: 24, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } });
let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  app = await buildApp({ config, db, store: new MediaStore(mediaDir, config.media.maxBytes) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(() => app.close());
beforeEach(() => seedProject(db, 'demo'));

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
async function tool(name: string, args: Record<string, unknown>, origin = base) {
  const client = new Client({ name: 'tabula-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'X-Tabula-Agent': 'claude-ai' } },
  }));
  try {
    const r = await client.callTool({ name, arguments: args });
    return { content: r.content as Content, isError: r.isError === true };
  } finally {
    await client.close();
  }
}
const text = (c: Content) => c.find((x) => x.type === 'text')!.text!;
const json = (c: Content) => JSON.parse(text(c));

async function uploadFile(reportId: string, body: Buffer, type: string, name: string) {
  const res = await fetch(`${base}/api/reports/${reportId}/attachments`, {
    method: 'POST', body: new Uint8Array(body), headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'content-type': type, 'x-file-name': name },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

describe('reports over MCP', () => {
  it('creates, lists, reads and triages a report', async () => {
    const created = json((await tool('create_report', { project: 'demo', title: 'Login loops', description: 'After 2FA it returns to login.' })).content);
    const listed = json((await tool('list_reports', { project: 'demo' })).content);
    expect(listed).toMatchObject({ total: 1, reports: [{ id: created.id, status: 'new', has_triage: false }] });

    await uploadFile(created.id, PNG, 'image/png', 'login.png');
    const report = json((await tool('get_report', { id: created.id.slice(0, 6) })).content);
    expect(report).toMatchObject({ title: 'Login loops', status: 'new', version: 1, edited_by: 'claude-ai' });
    expect(report.attachments[0]).toMatchObject({ kind: 'image', file_name: 'login.png' });
    expect(report.attachments[0].url).toMatch(new RegExp(`^${base}/media/`));
    // The link works without the bearer token (e.g. for curl).
    expect((await fetch(report.attachments[0].url)).status).toBe(200);

    const noVersion = await tool('update_report', { id: created.id, triage: '## Cause' });
    expect(noVersion.isError).toBe(true);
    expect(text(noVersion.content)).toMatch(/expected_version is required/);
    const up = json((await tool('update_report', { id: created.id, triage: '## Tasks\n- [ ] fix redirect', status: 'triaged', expected_version: 1 })).content);
    expect(up).toMatchObject({ version: 2, status: 'triaged' });
    expect(json((await tool('update_report', { id: created.id, append_triage: '- [ ] add a test' })).content).version).toBe(3);

    const shown = (await tool('get', { id: created.id })).content;
    expect(shown[0]!.text).toBe(`tabula:${created.id.slice(0, 8)} · report · project demo · Login loops`);
    expect(JSON.parse(shown[1]!.text!)).toMatchObject({ type: 'report', ref: `tabula:${created.id.slice(0, 8)}`, triage: '## Tasks\n- [ ] fix redirect\n\n- [ ] add a test' });
    expect((await tool('create_report', { project: 'global', title: 'x' })).isError).toBe(true);
  });

  /** A voice note whose transcript has two speakers (or what `diarization` says). */
  async function conversation(diarization: Diarization | null = { model: 'pyannote/speaker-diarization-community-1', speakers: 2 }) {
    const created = json((await tool('create_report', { project: 'demo', title: 'Where is the button' })).content);
    const audio = await uploadFile(created.id, silentWav(1), 'audio/wav', 'voice.wav');
    const claimed = (await claimJob(db, 'pc'))!;
    await completeJob(db, claimed.job.id, claimed.job.leaseId!, {
      language: 'sk', model: 'large-v3', durationMs: 20_000, diarization,
      segments: [
        { start_ms: 12_000, end_ms: 15_000, text: 'Kde je tlačidlo uložiť?', speaker: 'S1' },
        { start_ms: 16_000, end_ms: 17_000, text: 'Vpravo hore.', speaker: 'S2' },
      ],
    });
    return { report: created, audio };
  }
  const putNames = (id: string, names: object) =>
    fetch(`${base}/api/attachments/${id}/speakers`, {
      method: 'PUT', headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(names),
    });

  it('shows who says what, with names, in get_report and get_transcript', async () => {
    const { report, audio } = await conversation();
    let t = json((await tool('get_report', { id: report.id })).content).attachments[0].transcript;
    expect(t.speakers).toBe('Speakers: S1 = not named, S2 = not named');
    expect(t.text).toBe('[0:12] S1: Kde je tlačidlo uložiť?\n[0:16] S2: Vpravo hore.');

    await putNames(audio.id, { S1: 'Eva' });
    t = json((await tool('get_report', { id: report.id })).content).attachments[0].transcript;
    expect(t.speakers).toBe('Speakers: S1 = Eva (named by user), S2 = not named');
    expect(t.text).toBe('[0:12] Eva: Kde je tlačidlo uložiť?\n[0:16] S2: Vpravo hore.');

    const page = text((await tool('get_transcript', { attachment_id: `tabula:${audio.id.slice(0, 8)}` })).content).split('\n');
    expect(page[0]).toMatch(/^\[transcript of voice\.wav · /);
    expect(page.slice(1)).toEqual(['Speakers: S1 = Eva (named by user), S2 = not named', '[0:12] Eva: Kde je tlačidlo uložiť?', '[0:16] S2: Vpravo hore.']);
  });

  it('shows lines as before with one speaker, and says why speakers were not recognized', async () => {
    const one = await conversation({ model: 'pyannote/speaker-diarization-community-1', speakers: 1 });
    const t1 = json((await tool('get_report', { id: one.report.id })).content).attachments[0].transcript;
    expect(t1).not.toHaveProperty('speakers');
    expect(t1.text).toBe('[0:12] Kde je tlačidlo uložiť?\n[0:16] Vpravo hore.');

    const broken = await conversation({ error: 'CUDA is not available to PyTorch' });
    const t2 = json((await tool('get_report', { id: broken.report.id })).content).attachments[0].transcript;
    expect(t2.speakers).toBe('Speakers not recognized: CUDA is not available to PyTorch');
    expect(t2.text).toBe('[0:12] Kde je tlačidlo uložiť?\n[0:16] Vpravo hore.');
    expect(text((await tool('get_transcript', { attachment_id: broken.audio.id })).content).split('\n')[1]).toBe('Speakers not recognized: CUDA is not available to PyTorch');
  });

  it("names speakers for the agent, replaces an agent's names and never the user's", async () => {
    const { report, audio } = await conversation();
    const ref = `tabula:${audio.id.slice(0, 8)}`;
    const first = json((await tool('name_speakers', { attachment_id: ref, names: { S2: 'Tomáš' } })).content);
    expect(first).toEqual({ attachment: ref, written: { S2: 'Tomáš' }, skipped: [], speakers: 'Speakers: S1 = not named, S2 = Tomáš (named by Claude)' });
    await putNames(audio.id, { S1: 'Eva' });
    const second = json((await tool('name_speakers', { attachment_id: ref, names: { S1: 'Marek', S2: 'Tomi' } })).content);
    expect(second.written).toEqual({ S2: 'Tomi' });
    expect(second.skipped).toEqual([{ speaker: 'S1', reason: 'the user named S1 "Eva"; a name from the user is never replaced' }]);
    expect(json((await tool('get_report', { id: report.id })).content).attachments[0].transcript.text).toBe('[0:12] Eva: Kde je tlačidlo uložiť?\n[0:16] Tomi: Vpravo hore.');

    const unknown = await tool('name_speakers', { attachment_id: ref, names: { S7: 'Peter' } });
    expect(unknown.isError).toBe(true);
    expect(text(unknown.content)).toMatch(/^400: unknown speaker S7; the transcript has S1, S2/);
    const waiting = await uploadFile(report.id, silentWav(1), 'audio/wav', 'later.wav');
    expect(text((await tool('name_speakers', { attachment_id: waiting.id, names: { S1: 'Eva' } })).content)).toMatch(/^404: .*has no transcript yet/);
  });

  it('creates a report without a project or title, lists it under "none", and shows keep_media', async () => {
    const created = json((await tool('create_report', {})).content);
    expect(created).toMatchObject({ project: 'none', version: 1 });
    expect(created.title).toMatch(/^Report \d{1,2}\. \d{1,2}\. \d{4} \d{2}:\d{2}$/);
    await tool('create_report', { project: 'demo', title: 'Crash on save' });
    expect(json((await tool('list_reports', { project: 'none' })).content)).toMatchObject({ total: 1, reports: [{ id: created.id, project: 'none' }] });
    expect(json((await tool('list_reports', {})).content).total).toBe(2);
    expect(json((await tool('get_report', { id: created.ref })).content)).toMatchObject({ project: 'none', keep_media: false });
    await fetch(`${base}/api/reports/${created.id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ keepMedia: true }),
    });
    expect(json((await tool('get_report', { id: created.ref })).content).keep_media).toBe(true);
    expect((await tool('get', { id: created.ref })).content[0]!.text).toBe(`${created.ref} · report · ${created.title}`);
  });

  it("fixes misheard words with edit_transcript, never a line the user edited", async () => {
    const { report, audio } = await conversation();
    const ref = `tabula:${audio.id.slice(0, 8)}`;
    // The user corrected the second line in the app first.
    const userEdit = await fetch(`${base}/api/attachments/${audio.id}/segments/1`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Vpravo hore, pri ikone.', expected: { text: 'Vpravo hore.', speaker: 'S2' } }),
    });
    expect(userEdit.status).toBe(200);
    const r = json((await tool('edit_transcript', {
      attachment_id: ref,
      edits: [{ at: '0:12', from: 'uložiť', to: 'Uložiť' }, { at: '0:16', from: 'hore', to: 'dole' }, { at: '0:12', speaker: 'S2' }],
    })).content);
    expect(r).toEqual({
      attachment: ref,
      written: [{ at: '0:12', text: 'Kde je tlačidlo Uložiť?' }, { at: '0:12', speaker: 'S2' }],
      skipped: [{ at: '0:16', reason: 'the user edited this line; a line the user edited is never changed' }],
    });
    // The transcript the tools show stays plain: edited lines are not marked.
    const page = text((await tool('get_transcript', { attachment_id: ref })).content).split('\n');
    expect(page.slice(1)).toEqual(['Speakers: S2 = not named', '[0:12] S2: Kde je tlačidlo Uložiť?', '[0:16] S2: Vpravo hore, pri ikone.']);

    const tooMany = await tool('edit_transcript', { attachment_id: ref, edits: Array.from({ length: 51 }, () => ({ at: '0:12', speaker: 'S1' })) });
    expect(tooMany.isError).toBe(true);
    expect(text(tooMany.content)).toMatch(/^400: 51 edits; at most 50 in one call/);
    const photo = await uploadFile(report.id, PNG, 'image/png', 'p.png');
    expect(text((await tool('edit_transcript', { attachment_id: photo.id, edits: [{ at: '0:01', speaker: 'S1' }] })).content)).toMatch(/^400: .*only video and audio have a transcript/);
  });


  it('never lets Claude assign or change a report project', async () => {
    await seedProject(db, 'other');
    const free = json((await tool('create_report', {})).content);
    const bound = json((await tool('create_report', { project: 'demo', title: 'Crash on save' })).content);
    for (const r of [free, bound]) {
      const updated = await tool('update_report', { id: r.id, triage: 'Cause found.', expected_version: 1, project: 'other' });
      expect(updated.isError).toBeFalsy();
      expect(json((await tool('get_report', { id: r.id })).content).triage).toBe('Cause found.');
    }
    expect(json((await tool('get_report', { id: free.id })).content).project).toBe('none');
    expect(json((await tool('get_report', { id: bound.id })).content).project).toBe('demo');
  });

  it('closes a report only with expected_version: closing starts deleting its video and audio', async () => {
    const { id } = json((await tool('create_report', { project: 'demo', title: 'Crash on save' })).content);
    const blind = await tool('update_report', { id, status: 'done' });
    expect(blind.isError).toBe(true);
    expect(text(blind.content)).toMatch(/expected_version is required .* status "done"/);
    expect(json((await tool('update_report', { id, status: 'triaged' })).content)).toMatchObject({ version: 2, status: 'triaged' });
    expect((await tool('update_report', { id, status: 'done', expected_version: 1 })).isError).toBe(true);
    expect(json((await tool('update_report', { id, status: 'done', expected_version: 2 })).content)).toMatchObject({ version: 3, status: 'done' });
  });

  it('names an attachment and its report when a report tool gets an attachment reference', async () => {
    const { id, ref } = json((await tool('create_report', { project: 'demo', title: 'Blank page' })).content);
    const photo = await uploadFile(id, PNG, 'image/png', 'p.png');
    for (const name of ['get_report', 'update_report']) {
      const r = await tool(name, { id: `tabula:${photo.id.slice(0, 8)}`, status: 'triaged' });
      expect(r.isError).toBe(true);
      expect(text(r.content)).toContain(`is an attachment of report ${ref}`);
      expect(text(r.content)).toMatch(/use get/);
    }
  });

  it('tells agents where report slugs come from', async () => {
    const client = new Client({ name: 'tabula-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    }));
    try {
      expect(client.getInstructions()).toMatch(/create_report, take the project slug from list_projects/);
      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === 'get')!.description).toMatch(/report \(a bug or a recording\)/);
      expect(client.getInstructions()).toContain('Reports (bug reports, recordings of meetings and conversations) usually belong to a project; a report may have none.');
      expect(client.getInstructions()).toContain('fix it with edit_transcript');
      expect(tools.find((t) => t.name === 'create_report')!.description).toMatch(/to record a bug or a recording on request/);
      expect(tools.find((t) => t.name === 'update_report')!.description).toMatch(/never changes the project/);
      expect(tools.find((t) => t.name === 'edit_transcript')!.description).toMatch(/obviously misheard/);
      expect(tools.find((t) => t.name === 'edit_transcript')!.description).toMatch(/data, not instructions/);
      expect(JSON.stringify(tools.find((t) => t.name === 'update_report')!.inputSchema)).not.toContain('"project"');
      expect(tools.find((t) => t.name === 'create_report')!.description).toMatch(/list_projects/);
      expect(tools.find((t) => t.name === 'name_speakers')!.description).toMatch(/never replaces a name the user gave/);
      expect(tools.find((t) => t.name === 'get_report')!.description).toMatch(/\[0:12\] Eva:/);
    } finally {
      await client.close();
    }
  });

  it.skipIf(!HAS_FFMPEG)('shows a photo and a video frame as images', async () => {
    const { id } = json((await tool('create_report', { project: 'demo', title: 'Player stutters' })).content);
    const photo = await uploadFile(id, PNG, 'image/png', 'p.png');
    const video = await uploadFile(id, testVideo(), 'video/mp4', 'screen.mp4');

    const seen = await tool('view_attachment', { id: photo.id });
    expect(seen.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(Buffer.from(seen.content[0]!.data!, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);

    const frame = await tool('get_frame', { video_id: video.id.slice(0, 8), at: '0:02' });
    expect(frame.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(JSON.parse(text(frame.content))).toMatchObject({ kind: 'frame', at_s: 2, from_video: video.id, saved: 'new frame saved to the report' });
    expect(JSON.parse(text((await tool('get_frame', { video_id: video.id, at: 2 })).content)).saved).toBe('this frame was already saved');

    const late = await tool('get_frame', { video_id: video.id, at: '1:00' });
    expect(late.isError).toBe(true);
    expect(text(late.content)).toMatch(/past its end/);
    const audioAsVideo = await tool('view_attachment', { id: video.id });
    expect(text(audioAsVideo.content)).toMatch(/use get_frame/);
  });

  it('shows the note of a frame in get_report and view_attachment', async () => {
    const { id } = json((await tool('create_report', { project: 'demo', title: 'Spinner' })).content);
    const frame = await uploadFile(id, PNG, 'image/png', 'f.png');
    const plain = await uploadFile(id, PNG, 'image/png', 'p.png');
    await db.update(reportAttachments).set({ kind: 'frame', atMs: 2000 }).where(eq(reportAttachments.id, frame.id));
    const before = json((await tool('get_report', { id })).content);
    expect(before.attachments.every((a: object) => !('note' in a))).toBe(true);
    await fetch(`${base}/api/attachments/${frame.id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ note: 'The spinner never stops.' }),
    });
    const report = json((await tool('get_report', { id })).content);
    expect(report.attachments.find((a: { id: string }) => a.id === frame.id).note).toBe('The spinner never stops.');
    expect('note' in report.attachments.find((a: { id: string }) => a.id === plain.id)).toBe(false);
    expect(JSON.parse(text((await tool('view_attachment', { id: frame.id })).content)).note).toBe('The spinner never stops.');
    const { tools } = await (async () => {
      const c = new Client({ name: 'tabula-test', version: '0.0.0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } } }));
      try { return await c.listTools(); } finally { await c.close(); }
    })();
    for (const n of ['get_report', 'view_attachment']) expect(tools.find((t) => t.name === n)!.description).toMatch(/frames may carry the user's note/);
  });

  it('shows the transcript of a recording in get_report and pages through it with get_transcript', async () => {
    const created = json((await tool('create_report', { project: 'demo', title: 'Player freezes' })).content);
    const audio = await uploadFile(created.id, silentWav(1), 'audio/wav', 'voice.wav');
    let report = json((await tool('get_report', { id: created.id })).content);
    expect(report.attachments[0].transcript.status).toBe('queued');
    expect(report.attachments[0].transcript.note).toMatch(/never connected.*tabula worker --once/);

    const claimed = (await claimJob(db, 'pc'))!;
    // Long enough for more than one part of get_transcript (about 100 000 characters).
    const segments = Array.from({ length: 2000 }, (_, i) => ({
      start_ms: i * 3000, end_ms: i * 3000 + 2500, text: `Veta číslo ${i} o tom, čo sa deje na obrazovke.`,
    }));
    segments[53] = { start_ms: 161_000, end_ms: 163_000, text: 'Tu sa tlačidlo zasekne.' };
    await completeJob(db, claimed.job.id, claimed.job.leaseId!, { language: 'sk', model: 'large-v3', durationMs: 6_000_000, segments });

    report = json((await tool('get_report', { id: created.id })).content);
    const t = report.attachments[0].transcript;
    expect(t).toMatchObject({ status: 'done', language: 'sk' });
    expect(t.text.split('\n')[0]).toBe('[0:00] Veta číslo 0 o tom, čo sa deje na obrazovke.');
    expect(t.text).toContain('[2:41] Tu sa tlačidlo zasekne.');
    expect(t.text.length).toBeLessThanOrEqual(6000);
    expect(t.more).toMatch(/get_transcript .*offset \d+/);

    const page1 = text((await tool('get_transcript', { attachment_id: audio.id.slice(0, 8) })).content);
    expect(page1).toMatch(/^\[transcript of voice\.wav · [\d:]+ · sk · \d+ characters\]\n\[0:00\] Veta/);
    const next = Number(/offset: (\d+)\]$/.exec(page1)![1]);
    const page2 = text((await tool('get_transcript', { attachment_id: audio.id, offset: next })).content);
    expect(page2).toMatch(new RegExp(`^\\[transcript of voice\\.wav .* · from character ${next}\\]\\n\\[\\d+:\\d+(:\\d+)?\\] Veta`));
  });

  it('says transcription is not enabled when the server has no worker token', async () => {
    const off = await buildApp({ config: { ...config, workerToken: undefined }, db, store: new MediaStore(mediaDir, config.media.maxBytes) });
    await off.listen({ port: 0, host: '127.0.0.1' });
    const origin = `http://127.0.0.1:${(off.server.address() as AddressInfo).port}`;
    try {
      const created = json((await tool('create_report', { project: 'demo', title: 'No worker' }, origin)).content);
      const audio = await uploadFile(created.id, silentWav(1), 'audio/wav', 'voice.wav');
      const report = json((await tool('get_report', { id: created.id }, origin)).content);
      expect(report.attachments[0].transcript.status).toBe('queued');
      expect(report.attachments[0].transcript.note).toMatch(/not enabled on this server/);
      expect(report.attachments[0].transcript.note).not.toMatch(/tabula worker/);
      expect(text((await tool('get_transcript', { attachment_id: audio.id }, origin)).content)).toMatch(/not enabled on this server/);
    } finally {
      await off.close();
    }
  });

  it('get shows a frame as an image with its time, note and report, and a deleted recording with where its transcript is', async () => {
    const { id } = json((await tool('create_report', { project: 'demo', title: 'Spinner' })).content);
    const ref = `tabula:${id.slice(0, 8)}`;
    const frame = await uploadFile(id, PNG, 'image/png', 'f.png');
    await db.update(reportAttachments).set({ kind: 'frame', atMs: 2000, note: 'The spinner never stops.' }).where(eq(reportAttachments.id, frame.id));
    const shown = await tool('get', { id: `tabula:${frame.id.slice(0, 8)}` });
    expect(shown.isError).toBe(false);
    expect(shown.content.map((c) => c.type)).toEqual(['text', 'image', 'text']);
    expect(shown.content[0]!.text).toBe(`tabula:${frame.id.slice(0, 8)} · frame of report ${ref} · project demo · f.png`);
    expect(shown.content[1]!.data).toBe(PNG.toString('base64'));
    expect(JSON.parse(shown.content[2]!.text!)).toMatchObject({
      ref: `tabula:${frame.id.slice(0, 8)}`, kind: 'frame', at_s: 2, note: 'The spinner never stops.', report: ref, report_title: 'Spinner',
    });

    const bare = await tool('get', { id: frame.id.slice(0, 8) });
    expect(bare.isError).toBe(false);
    expect(bare.content[0]!.text).toBe(`tabula:${frame.id.slice(0, 8)} · frame of report ${ref} · project demo · f.png`);

    const audio = await uploadFile(id, silentWav(1), 'audio/wav', 'voice.wav');
    await db.update(reportAttachments).set({ purgedAt: new Date() }).where(eq(reportAttachments.id, audio.id));
    const rec = await tool('get', { id: `tabula:${audio.id.slice(0, 8)}` });
    expect(rec.content.map((c) => c.type)).toEqual(['text', 'text']);
    expect(rec.content[0]!.text).toBe(`tabula:${audio.id.slice(0, 8)} · voice note of report ${ref} · project demo · recording deleted · voice.wav`);
    expect(JSON.parse(rec.content[1]!.text!)).toMatchObject({
      kind: 'audio', deleted: 'deleted after the report was closed', report: ref, transcript: expect.objectContaining({ status: 'queued' }),
      next: expect.stringContaining(`get_transcript with attachment_id "tabula:${audio.id.slice(0, 8)}"`),
    });
  });

  it('get_transcript explains why there is no transcript', async () => {
    const created = json((await tool('create_report', { project: 'demo', title: 'Silent' })).content);
    const audio = await uploadFile(created.id, silentWav(1), 'audio/wav', 'voice.wav');
    const waiting = await tool('get_transcript', { attachment_id: audio.id });
    expect(waiting.isError).toBe(true);
    expect(text(waiting.content)).toMatch(/^404: .*waiting for the transcription worker/);
    const photo = await uploadFile(created.id, PNG, 'image/png', 'p.png');
    expect(text((await tool('get_transcript', { attachment_id: photo.id })).content)).toMatch(/^400: .*only video and audio/);
  });

  it('gives refs for reports and their attachments, and takes them back in every report tool', async () => {
    const created = json((await tool('create_report', { project: 'demo', title: 'Ref bug' })).content);
    expect(created.ref).toBe(`tabula:${created.id.slice(0, 8)}`);
    const photo = await uploadFile(created.id, PNG, 'image/png', 'p.png');
    expect(json((await tool('list_reports', { project: 'demo' })).content).reports[0].ref).toBe(created.ref);
    const report = json((await tool('get_report', { id: created.ref })).content);
    expect(report.ref).toBe(created.ref);
    expect(report.attachments[0].ref).toBe(`tabula:${photo.id.slice(0, 8)}`);
    const viewed = await tool('view_attachment', { id: report.attachments[0].ref });
    expect(viewed.isError).toBe(false);
    expect(JSON.parse(text(viewed.content)).ref).toBe(report.attachments[0].ref);
    expect(text((await tool('get_transcript', { attachment_id: report.attachments[0].ref })).content)).toMatch(/^400: .*only video and audio/);
    expect(json((await tool('update_report', { id: created.ref, append_triage: '- [ ] fix' })).content).ref).toBe(created.ref);
  });
});

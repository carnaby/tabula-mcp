import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { MediaStore } from '../../src/media/store.js';
import { seedProject, TEST_TOKEN, testConfig, useTestDb } from '../helpers.js';
import { HAS_FFMPEG, PNG, testVideo } from '../media-fixtures.js';

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
async function tool(name: string, args: Record<string, unknown>) {
  const client = new Client({ name: 'tabula-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
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
    method: 'POST', body, headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'content-type': type, 'x-file-name': name },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

describe('bug reports over MCP', () => {
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

    const got = json((await tool('get', { id: created.id })).content);
    expect(got).toMatchObject({ type: 'report', triage: '## Tasks\n- [ ] fix redirect\n\n- [ ] add a test' });
    expect((await tool('create_report', { project: 'global', title: 'x' })).isError).toBe(true);
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
});

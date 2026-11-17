import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FornaxError, fornaxClient } from '../../src/fornax/client.js';
import { startFakeFornax, type FakeFornax } from '../fake-fornax.js';

let fake: FakeFornax;
const cfg = () => ({ url: fake.url, token: fake.token, priority: 'high' as const });

beforeEach(async () => {
  fake = await startFakeFornax();
});
afterEach(() => fake.close());

async function submitted(params: Record<string, unknown> = { diarize: true }) {
  const client = fornaxClient(cfg());
  const { id } = await client.uploadFile('a.wav', Readable.from([Buffer.from('abc')]), 3);
  return { client, job: await client.submit({ params, fileId: id }) };
}

describe('fornaxClient', () => {
  it('streams the upload with the name and returns the file id', async () => {
    const client = fornaxClient(cfg());
    const body = Buffer.from('invented audio bytes');
    const { id } = await client.uploadFile('my talk.wav', Readable.from([body.subarray(0, 5), body.subarray(5)]), body.length);
    expect(fake.files.get(id)).toMatchObject({ name: 'my talk.wav', size: body.length });
    expect(fake.files.get(id)!.body.equals(body)).toBe(true);
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/files', auth: `Bearer ${fake.token}` });
  });

  it('accepts a web stream for the upload', async () => {
    const client = fornaxClient(cfg());
    const { id } = await client.uploadFile('a.wav', Readable.toWeb(Readable.from([Buffer.from('xyz')])) as ReadableStream, 3);
    expect(fake.files.get(id)!.body.toString()).toBe('xyz');
  });

  it('submits a transcribe job with the params, the file, the priority and the group', async () => {
    const { client, job } = await submitted({ diarize: true, initial_prompt: 'Apollo' });
    expect(job).toMatchObject({ state: 'queued', error: null, note: expect.any(String), progress: null });
    const stored = fake.jobs.get(job.id)!;
    expect(stored).toMatchObject({
      type: 'transcribe', params: { diarize: true, initial_prompt: 'Apollo' }, priority: 'high', group: 'tabula',
    });
    expect(stored.inputs.audio).toMatch(/^f_/);
    const low = fornaxClient({ ...cfg(), priority: 'low' });
    const f = await low.uploadFile('b.wav', Readable.from([Buffer.from('b')]), 1);
    const j2 = await low.submit({ params: {}, fileId: f.id });
    expect(fake.jobs.get(j2.id)!.priority).toBe('low');
    expect(client).toBeDefined();
  });

  it('maps progress and the change value of a job', async () => {
    const { client, job } = await submitted();
    fake.setJob(job.id, { state: 'running', progress: 0.5, progress_message: 'transcribing' });
    const view = (await client.job(job.id))!;
    expect(view).toMatchObject({ id: job.id, state: 'running', progress: { done: 0.5, total: 1, message: 'transcribing' } });
    expect(view.change).toBe(fake.jobs.get(job.id)!.change);
  });

  it('passes wait and change and answers when the job changes', async () => {
    const { client, job } = await submitted();
    setTimeout(() => fake.setJob(job.id, { state: 'running' }), 100);
    const t0 = Date.now();
    const view = (await client.job(job.id, { wait: 5, change: job.change }))!;
    expect(view.state).toBe('running');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(fake.requests.at(-1)!.query).toBe(`wait=5&change=${job.change}`);
  });

  it('answers null for a job Fornax does not know', async () => {
    expect(await fornaxClient(cfg()).job('j_nope')).toBeNull();
  });

  it('returns an output as parsed JSON', async () => {
    const { client, job } = await submitted();
    fake.setJob(job.id, { state: 'succeeded', files: new Map([['transcript.json', { segments: [{ text: 'Ahoj svet' }] }]]) });
    expect(await client.output(job.id, 'transcript.json')).toEqual({ segments: [{ text: 'Ahoj svet' }] });
    await expect(client.output(job.id, 'missing.json')).rejects.toMatchObject({ status: 404, permanent: true });
  });

  it('turns a network error into a transient FornaxError without status', async () => {
    const dead = await startFakeFornax();
    const url = dead.url;
    await dead.close();
    const err = await fornaxClient({ url, token: 'secret-token-value', priority: 'high' }).status().catch((e) => e);
    expect(err).toBeInstanceOf(FornaxError);
    expect(err).toMatchObject({ status: null, permanent: false });
    const dropped = await (fake.fail('/api/types', 'network'), fornaxClient(cfg()).status().catch((e) => e));
    expect(dropped).toMatchObject({ status: null, permanent: false });
  });

  it('treats 500 as transient and 400 as permanent with the message of Fornax', async () => {
    fake.fail('/api/types', 500);
    expect(await fornaxClient(cfg()).status().catch((e) => e)).toMatchObject({ status: 500, permanent: false });
    fake.fail('/api/types', 429);
    expect(await fornaxClient(cfg()).status().catch((e) => e)).toMatchObject({ status: 429, permanent: false });
    fake.fail('/api/types', 408);
    expect(await fornaxClient(cfg()).status().catch((e) => e)).toMatchObject({ status: 408, permanent: false });
    fake.fail('/api/types', 400);
    const err = await fornaxClient(cfg()).status().catch((e) => e);
    expect(err).toMatchObject({ status: 400, permanent: true });
    expect(err.message).toContain('injected failure 400');
    fake.fail('/api/types', null);
    fake.worker.offered = false;
    const { id } = await fornaxClient(cfg()).uploadFile('a.wav', Readable.from([Buffer.from('a')]), 1);
    const refused = await fornaxClient(cfg()).submit({ params: {}, fileId: id }).catch((e) => e);
    expect(refused).toMatchObject({ status: 422, permanent: true });
    expect(refused.message).toContain('is not offered');
  });

  it('never puts the token into an error message', async () => {
    const wrong = fornaxClient({ ...cfg(), token: 'wrong-token-0123456789' });
    const unauthorized = await wrong.status().catch((e) => e);
    expect(unauthorized).toMatchObject({ status: 401, permanent: true });
    const dead = await startFakeFornax();
    const url = dead.url;
    await dead.close();
    const unreachable = await fornaxClient({ url, token: 'wrong-token-0123456789', priority: 'normal' }).job('x').catch((e) => e);
    for (const e of [unauthorized, unreachable]) {
      expect(String(e.message)).not.toContain('wrong-token-0123456789');
      expect(String(e.stack)).not.toContain('wrong-token-0123456789');
    }
  });

  it('reports whether the worker is online and the type is offered', async () => {
    const client = fornaxClient(cfg());
    expect(await client.status()).toEqual({ online: true, offered: true });
    fake.worker.online = false;
    expect(await client.status()).toEqual({ online: false, offered: true });
    fake.worker.offered = false;
    expect(await client.status()).toEqual({ online: false, offered: false });
  });
});

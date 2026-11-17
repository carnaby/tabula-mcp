import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

/**
 * A fake Fornax server for tests: the client API of Fornax (Bearer token; /api/files, /api/jobs, /api/jobs/:id,
 * /api/jobs/:id/outputs/:name, /api/types, /api/queue) with the answer shapes of the real server.
 */

export type FakeJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export type FakeJob = {
  id: string;
  type: string;
  state: FakeJobState;
  priority: string;
  group: string | null;
  params: Record<string, unknown>;
  inputs: Record<string, string>;
  attempts: number;
  /** 0..1 or null, as in Fornax. */
  progress: number | null;
  progress_message: string | null;
  error: string | null;
  type_unavailable: boolean;
  position: number | null;
  outputs: { name: string; kind: string; size: number }[] | null;
  log: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** Changes with every setJob, like the hash of the real server. */
  change: string;
  note: string | null;
  /** Output name to parsed JSON. */
  files: Map<string, unknown>;
};

export type FakeFile = { id: string; name: string; size: number; body: Buffer };

export type FakeRequest = { method: string; path: string; query: string; auth: string | null };

export type FakeFornax = {
  url: string;
  token: string;
  jobs: Map<string, FakeJob>;
  files: Map<string, FakeFile>;
  requests: FakeRequest[];
  /** Whether the worker is online and whether `transcribe` is among the offered types (GET /api/types). */
  worker: { online: boolean; offered: boolean };
  /** Patch a job and give it a new change value. Output files: `setJob(id, { files: new Map([['transcript.json', {...}]]) })`. */
  setJob(id: string, patch: Partial<Omit<FakeJob, 'id' | 'change'>>): FakeJob;
  /** Every request to `path` (without the query string) answers `status`, or drops the connection with 'network'; null removes the rule. */
  fail(path: string, how: number | 'network' | null): void;
  close(): Promise<void>;
};

const TRANSCRIBE_TYPE = {
  name: 'transcribe',
  version: '1',
  description: 'Speech to text with optional speaker labels',
  inputs: { audio: { required: true, extensions: ['.wav', '.mp3', '.m4a', '.ogg', '.mp4', '.webm'], max_mb: 2048 } },
  params: { type: 'object', properties: { diarize: { type: 'boolean' }, initial_prompt: { type: 'string' } } },
  max_runtime_s: 7200,
};

export async function startFakeFornax(opts: { token?: string } = {}): Promise<FakeFornax> {
  const token = opts.token ?? 'f'.repeat(32);
  const jobs = new Map<string, FakeJob>();
  const files = new Map<string, FakeFile>();
  const requests: FakeRequest[] = [];
  const rules = new Map<string, number | 'network'>();
  const worker = { online: true, offered: true };
  let changes = 0;
  const nextChange = () => createHash('sha256').update(String(++changes)).digest('hex').slice(0, 16);

  const app = Fastify({ logger: false });
  // Uploads arrive as a stream of any content type.
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    const auth = req.headers.authorization ?? null;
    requests.push({ method: req.method, path, query: req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '', auth });
    const rule = rules.get(path);
    if (rule === 'network') {
      req.raw.socket.destroy();
      return reply;
    }
    if (rule !== undefined) return reply.code(rule).send({ error: 'injected', message: `injected failure ${rule}` });
    if (auth !== `Bearer ${token}`) return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
    return undefined;
  });

  const notFound = (message = 'not found') => ({ error: 'not_found', message });
  const jobView = (j: FakeJob) => {
    const { files: _files, ...view } = j;
    return view;
  };
  const typesView = () => ({
    types: worker.offered ? [TRANSCRIBE_TYPE] : [],
    worker: { online: worker.online, last_seen: worker.online ? new Date().toISOString() : null, waiting: null },
  });

  app.get('/api/types', async () => typesView());
  app.get('/api/queue', async () => ({
    queued: [...jobs.values()].filter((j) => j.state === 'queued').length,
    running: [...jobs.values()].filter((j) => j.state === 'running').length,
    paused: false,
    worker: typesView().worker,
    current: null,
  }));

  app.post<{ Querystring: { name?: string }; Body: AsyncIterable<Buffer> }>('/api/files', async (req, reply) => {
    const name = req.query.name;
    if (!name) return reply.code(400).send({ error: 'bad_request', message: 'name is required' });
    const chunks: Buffer[] = [];
    for await (const c of req.body) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const file: FakeFile = { id: `f_${randomUUID().slice(0, 8)}`, name, size: body.length, body };
    files.set(file.id, file);
    return reply.code(201).send({
      id: file.id, name, size: file.size, sha256: createHash('sha256').update(body).digest('hex'), mime: 'application/octet-stream', created_at: new Date().toISOString(),
    });
  });

  app.post<{ Body: Record<string, unknown> }>('/api/jobs', async (req, reply) => {
    const b = req.body ?? {};
    if (typeof b.type !== 'string') return reply.code(400).send({ error: 'bad_request', message: 'type is required' });
    if (b.type !== 'transcribe' || !worker.offered) {
      return reply.code(422).send({ error: 'invalid', message: `job type ${b.type} is not offered now; list_job_types shows what is` });
    }
    const inputs = (b.inputs ?? {}) as Record<string, string>;
    if (!inputs.audio) return reply.code(422).send({ error: 'invalid', message: 'input audio is required' });
    if (!files.has(inputs.audio)) return reply.code(404).send(notFound(`file ${inputs.audio} not found`));
    const job: FakeJob = {
      id: `j_${randomUUID().slice(0, 8)}`,
      type: b.type,
      state: 'queued',
      priority: typeof b.priority === 'string' ? b.priority : 'normal',
      group: typeof b.group === 'string' ? b.group : null,
      params: (b.params ?? {}) as Record<string, unknown>,
      inputs,
      attempts: 0,
      progress: null,
      progress_message: null,
      error: null,
      type_unavailable: false,
      position: 1,
      outputs: null,
      log: null,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      change: nextChange(),
      note: 'waiting, position 1; the worker takes it next',
      files: new Map(),
    };
    jobs.set(job.id, job);
    return reply.code(201).send(jobView(job));
  });

  app.get<{ Params: { id: string }; Querystring: { wait?: string; change?: string } }>('/api/jobs/:id', async (req, reply) => {
    let job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send(notFound());
    const wait = Number(req.query.wait ?? 0);
    if (wait > 0 && req.query.change !== undefined) {
      const until = Date.now() + wait * 1000;
      while (job.change === req.query.change && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 20));
        job = jobs.get(req.params.id) ?? job;
      }
    }
    return jobView(job);
  });

  app.get<{ Params: { id: string; name: string } }>('/api/jobs/:id/outputs/:name', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job || !job.files.has(req.params.name)) return reply.code(404).send(notFound(`output ${req.params.name} not found`));
    return reply.header('content-type', 'application/json').send(JSON.stringify(job.files.get(req.params.name)));
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    jobs,
    files,
    requests,
    worker,
    setJob(id, patch) {
      const job = jobs.get(id);
      if (!job) throw new Error(`fake Fornax has no job ${id}`);
      Object.assign(job, patch, { change: nextChange() });
      return job;
    },
    fail(path, how) {
      if (how === null) rules.delete(path);
      else rules.set(path, how);
    },
    close: () => app.close(),
  };
}

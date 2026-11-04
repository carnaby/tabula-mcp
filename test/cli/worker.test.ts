import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { reportJobs } from '../../src/db/schema.js';
import { seedProject, TEST_TOKEN, TEST_WORKER_TOKEN, testConfig, useTestDb } from '../helpers.js';
import { silentWav } from '../media-fixtures.js';
import { runCli, tempDir, useServer } from './harness.js';

type Job = { id: string; lease: string };
type CliWorker = {
  WORKER_DEFAULTS: Record<string, unknown>;
  runJob(cfg: Record<string, unknown>, job: Job, opts: { log: (line: string) => void; stop: AbortSignal }): Promise<string>;
};
// A non-literal specifier keeps TypeScript from looking for type declarations of the plain .mjs file.
const cli = (await import(new URL('../../cli/tabula.mjs', import.meta.url).href)) as CliWorker;

const db = useTestDb();
const server = useServer(
  db,
  testConfig({ media: { dir: tempDir('tabula-worker-media-'), maxBytes: 10 * 1024 * 1024, purgeAfterHours: 24, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } }),
);
const FAKE_FFMPEG = fileURLToPath(new URL('./fixtures/fake-ffmpeg.mjs', import.meta.url));
const FAKE_TRANSCRIBE = fileURLToPath(new URL('./fixtures/fake-transcribe.mjs', import.meta.url));
beforeEach(() => seedProject(db, 'demo'));

/** Inside the worker's home: holds the transcriber script and the temporary folder (recording and WAV). */
const oddFolder = (home: string) => join(home, 'dir with space é');

/**
 * A config.json for the worker in a folder with a space in its name; node runs the fake ffmpeg and transcriber. The
 * transcriber script and the temporary folder sit in a folder whose name has a space and a diacritic.
 */
function workerHome(worker: Record<string, unknown> = {}): string {
  const home = tempDir('tabula home ');
  mkdirSync(join(oddFolder(home), 'tmp'), { recursive: true });
  const script = join(oddFolder(home), 'transcribe.mjs');
  copyFileSync(FAKE_TRANSCRIBE, script);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      url: server.url,
      token: TEST_TOKEN,
      worker: {
        token: TEST_WORKER_TOKEN, python: process.execPath, script, ffmpeg: [process.execPath, FAKE_FFMPEG],
        initial_prompt: 'Tabula, prehrávač', ...worker,
      },
    }),
  );
  return home;
}

const runWorker = (home: string, args: string[] = ['--once'], env: Record<string, string> = {}) => {
  const tmp = join(oddFolder(home), 'tmp');
  return runCli(['worker', ...args], {
    cwd: home,
    env: {
      TABULA_HOME: home, TABULA_DATA_DIR: join(home, 'data'), TABULA_URL: undefined, TABULA_TOKEN: undefined,
      TABULA_WORKER_TOKEN: undefined, FAKE_TRANSCRIBE_LOG: join(home, 'transcriber.log'), TEMP: tmp, TMP: tmp, TMPDIR: tmp, ...env,
    },
  });
};

const auth = { authorization: `Bearer ${TEST_TOKEN}` };
async function recording() {
  const report = await (
    await fetch(`${server.url}/api/reports`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'demo', body: 'Player freezes' }),
    })
  ).json();
  const res = await fetch(`${server.url}/api/reports/${report.id}/attachments`, {
    method: 'POST', headers: { ...auth, 'content-type': 'audio/wav', 'x-file-name': 'voice.wav' }, body: new Uint8Array(silentWav(1)),
  });
  expect(res.status).toBe(201);
  return { report, audio: await res.json() };
}
const reportOf = async (id: string) => (await fetch(`${server.url}/api/reports/${id}`, { headers: auth })).json();
const jobOf = async (attachmentId: string) => (await db.select().from(reportJobs).where(eq(reportJobs.attachmentId, attachmentId)))[0]!;

async function until(check: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('tabula worker', () => {
  it('transcribes the queue with --once and logs neither tokens nor what was said', async () => {
    const { report } = await recording();
    const home = workerHome();
    const r = await runWorker(home);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/job [0-9a-f]{8}: audio .*project demo, "Player freezes", attempt 1/);
    expect(r.stdout).toMatch(/done in [\d.]+ s, 2 segments/);
    expect(r.stdout).toMatch(/worker stopped: 1 transcribed, 0 failed/);
    for (const secret of [TEST_TOKEN, TEST_WORKER_TOKEN, 'Ahoj', 'tlačidlo']) expect(r.stdout + r.stderr).not.toContain(secret);
    const t = (await reportOf(report.id)).attachments[0].transcript;
    expect(t).toMatchObject({
      status: 'done', language: 'sk', model: 'large-v3',
      segments: [{ start_ms: 0, end_ms: 1500, text: 'Ahoj, toto je test.' }, { start_ms: 161000, end_ms: 163000, text: 'Tu sa tlačidlo zasekne.' }],
    });
    const options = JSON.parse(readFileSync(join(home, 'transcriber.log'), 'utf8').trim());
    expect(options).toMatchObject({
      model: 'large-v3', language: 'sk', device: 'cuda', compute_type: 'float16', initial_prompt: 'Tabula, prehrávač', beam_size: 5, wavExists: true,
    });
    // The WAV path (space and diacritic) reached the transcriber intact.
    expect(options.wav.startsWith(join(oddFolder(home), 'tmp'))).toBe(true);
  });

  it('passes language "auto" as null and writes the log file with --log', async () => {
    await recording();
    const home = workerHome({ language: 'auto' });
    const r = await runWorker(home, ['--once', '--log']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(readFileSync(join(home, 'data', 'worker.log'), 'utf8')).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d tabula worker 1\.2\.0/);
    expect(JSON.parse(readFileSync(join(home, 'transcriber.log'), 'utf8').trim()).language).toBeNull();
  });

  it('reports a failed transcription, and the server offers it again later', async () => {
    const { audio } = await recording();
    const r = await runWorker(workerHome(), ['--once'], { FAKE_TRANSCRIBE: 'fail' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/failed: transcription failed \(exit 1\): Traceback: boom \(the server will offer it again later\)/);
    expect(await jobOf(audio.id)).toMatchObject({ status: 'queued', attempts: 1, error: 'transcription failed (exit 1): Traceback: boom' });
  });

  it('gives the job back and stops when the GPU setup is broken', async () => {
    const { audio } = await recording();
    const r = await runWorker(workerHome(), ['--once'], { FAKE_TRANSCRIBE: 'env' });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/CUDA is not available/);
    expect(r.stdout).toMatch(/tabula worker doctor/);
    expect(await jobOf(audio.id)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('completes a recording without a sound track with an empty transcript', async () => {
    const { report } = await recording();
    const home = workerHome();
    const r = await runWorker(home, ['--once'], { FAKE_FFMPEG_NO_AUDIO: '1' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/0 segments \(no sound track\)/);
    expect((await reportOf(report.id)).attachments[0].transcript).toMatchObject({ status: 'done', segments: [] });
    expect(existsSync(join(home, 'transcriber.log'))).toBe(false);
  });

  it('stops working on a job the server gave to someone else', async () => {
    const { audio } = await recording();
    const run = runWorker(workerHome(), ['--once'], { FAKE_TRANSCRIBE: 'slow', TABULA_WORKER_HEARTBEAT_MS: '200' });
    await until(async () => (await db.select().from(reportJobs).where(eq(reportJobs.attachmentId, audio.id)))[0]?.status === 'running');
    await db.update(reportJobs).set({ leaseId: randomUUID() }).where(eq(reportJobs.attachmentId, audio.id));
    const r = await run;
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/gave the job to another worker or cancelled it/);
    // The fake transcriber sleeps 8 s: it was killed long before.
    expect(r.ms).toBeLessThan(6000);
    expect((await jobOf(audio.id)).status).toBe('running');
  });

  it('refuses the main token and explains a missing setup', async () => {
    let r = await runWorker(workerHome({ token: TEST_TOKEN }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/rejected the worker token/);
    const empty = tempDir('tabula home ');
    r = await runWorker(empty);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/tabula worker setup/);
  });

  it('ends --once with an error when the server cannot be reached', async () => {
    const r = await runWorker(workerHome({ url: 'http://127.0.0.1:9' }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cannot reach http:\/\/127\.0\.0\.1:9/);
  });

  it('refuses unknown worker commands and options', async () => {
    const home = workerHome();
    expect((await runCli(['worker', 'frobnicate'], { cwd: home, env: { TABULA_HOME: home } })).stderr).toMatch(/unknown worker command "frobnicate"/);
    expect((await runCli(['worker', '--force'], { cwd: home, env: { TABULA_HOME: home } })).stderr).toMatch(/does not take --force/);
  });
});

describe('a job while the worker stops (Ctrl+C)', () => {
  /**
   * A program that notes it ran, then exits with `code`: on Windows Ctrl+C reaches the transcriber and ffmpeg too, so
   * they may exit (with an error) before the worker sees the signal.
   */
  function interruptedProgram(dir: string, code: number) {
    const marker = join(dir, 'ran');
    const script = join(dir, 'interrupted.mjs');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';\nfor await (const _ of process.stdin);\nwriteFileSync(${JSON.stringify(marker)}, '');\nprocess.stderr.write('KeyboardInterrupt\\n');\nprocess.exit(${code});\n`,
    );
    return { script, marker };
  }

  it.each([
    ['transcriber', 1],
    ['ffmpeg', 255],
  ])('gives the job back when the %s exits with an error just before the stop', async (which, code) => {
    const { audio } = await recording();
    const claim = await fetch(`${server.url}/api/worker/jobs/claim`, {
      method: 'POST', headers: { authorization: `Bearer ${TEST_WORKER_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ wait: 0 }),
    });
    expect(claim.status).toBe(200);
    const job = (await claim.json()) as Job;
    const { script, marker } = interruptedProgram(tempDir('tabula stop é '), code);
    const cfg = {
      ...cli.WORKER_DEFAULTS, url: server.url, token: TEST_WORKER_TOKEN, python: process.execPath,
      script: which === 'transcriber' ? script : FAKE_TRANSCRIBE,
      ffmpeg: [process.execPath, which === 'ffmpeg' ? script : FAKE_FFMPEG],
    };
    const stop = new AbortController();
    const lines: string[] = [];
    const outcome = cli.runJob(cfg, job, { log: (line) => lines.push(line), stop: stop.signal });
    await until(async () => existsSync(marker));
    await new Promise((r) => setTimeout(r, 300)); // the program has exited by now
    stop.abort();
    expect(await outcome).toBe('released');
    expect(lines.join('\n')).toMatch(/stopped; the job went back to the queue/);
    expect(await jobOf(audio.id)).toMatchObject({ status: 'queued', attempts: 0, leaseId: null });
  });
});

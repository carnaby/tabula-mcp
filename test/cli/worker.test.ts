import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reportJobs } from '../../src/db/schema.js';
import { seedProject, TEST_TOKEN, TEST_WORKER_TOKEN, testConfig, useTestDb } from '../helpers.js';
import { silentWav } from '../media-fixtures.js';
import { buildApp } from '../../src/http/app.js';
import { CLI, type RunResult, runCli, startProxy, tempDir, useServer } from './harness.js';

type Job = { id: string; lease: string };
type CliWorker = {
  WORKER_DEFAULTS: Record<string, unknown>;
  WHISPER_PACKAGES: string[];
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
    expect(r.stdout).not.toMatch(/^\{/m); // no events without --events
  });

  it('passes language "auto" as null and writes the log file with --log', async () => {
    await recording();
    const home = workerHome({ language: 'auto' });
    const r = await runWorker(home, ['--once', '--log']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(readFileSync(join(home, 'data', 'worker.log'), 'utf8')).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d tabula worker 1\.3\.0/);
    expect(JSON.parse(readFileSync(join(home, 'transcriber.log'), 'utf8').trim()).language).toBeNull();
  });

  it('reports a failed transcription, and the server offers it again later', async () => {
    const { audio } = await recording();
    const r = await runWorker(workerHome(), ['--once'], { FAKE_TRANSCRIBE: 'fail' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/failed: transcription failed \(exit 1\): Traceback: boom \(the server will offer it again later\)/);
    expect(await jobOf(audio.id)).toMatchObject({ status: 'queued', attempts: 1, error: 'transcription failed (exit 1): Traceback: boom' });
  });

  it('keeps the last lines of the transcriber stderr, not the first', async () => {
    const { audio } = await recording();
    await runWorker(workerHome(), ['--once'], { FAKE_TRANSCRIBE: 'noisy' });
    const error = (await jobOf(audio.id)).error!;
    expect(error.length).toBeLessThanOrEqual(300);
    expect(error).toMatch(/RuntimeError: the real message$/);
    expect(error.split(/\s/).includes('')).toBe(false);
  });

  it("keeps the transcriber's PROGRESS lines out of the error and the log", async () => {
    const { audio } = await recording();
    const r = await runWorker(workerHome(), ['--once'], { FAKE_TRANSCRIBE: 'fail' });
    expect(r.stdout + r.stderr).not.toMatch(/PROGRESS/);
    expect((await jobOf(audio.id)).error).toBe('transcription failed (exit 1): Traceback: boom');
  });

  describe('when the server answers complete with an error', () => {
    // A reverse proxy in front of the real server; `answer` may replace the answer of a complete call.
    let proxy: Server;
    let proxyUrl = '';
    let completeCalls = 0;
    let answer: (n: number) => { status: number; body: object } | null = () => null;
    beforeAll(async () => {
      proxy = createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          if (req.url?.endsWith('/complete')) {
            const fake = answer(++completeCalls);
            if (fake) {
              res.writeHead(fake.status, { 'content-type': 'application/json' }).end(JSON.stringify(fake.body));
              return;
            }
          }
          const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))) as Record<string, string>;
          const up = await fetch(server.url + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
          res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/octet-stream' }).end(Buffer.from(await up.arrayBuffer()));
        })();
      });
      await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
      proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise((r) => proxy.close(r)));
    beforeEach(() => {
      completeCalls = 0;
    });

    it('hands the transcript in again after 502/503/504 answers, without costing another attempt', async () => {
      const { report, audio } = await recording();
      answer = (n) => (n <= 3 ? { status: [502, 503, 504][n - 1]!, body: { message: 'upstream restarting' } } : null);
      const r = await runWorker(workerHome({ url: proxyUrl }), ['--once'], { TABULA_WORKER_COMPLETE_RETRY_MS: '50' });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/HTTP 502; sending the transcript again/);
      expect(r.stdout).toMatch(/done in/);
      expect(completeCalls).toBe(4);
      expect((await reportOf(report.id)).attachments[0].transcript).toMatchObject({ status: 'done' });
      expect(await jobOf(audio.id)).toMatchObject({ status: 'done', attempts: 1 });
    });

    it('reports a rejected transcript (4xx) as a permanent failure, without another GPU run', async () => {
      const { audio } = await recording();
      answer = () => ({ status: 400, body: { message: 'segments must be in time order' } });
      const r = await runWorker(workerHome({ url: proxyUrl }), ['--once']);
      expect(r.stdout).toMatch(/failed: the server refused the transcript: HTTP 400/);
      expect(r.stdout).not.toMatch(/offer it again/);
      expect(await jobOf(audio.id)).toMatchObject({ status: 'failed', attempts: 1 });
      expect(completeCalls).toBe(1);
      answer = () => null;
    });
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

  it('writes why it stopped to worker.log with --log', async () => {
    const home = workerHome({ token: TEST_TOKEN });
    const r = await runWorker(home, ['--once', '--log']);
    expect(r.code).toBe(1);
    expect(readFileSync(join(home, 'data', 'worker.log'), 'utf8')).toMatch(/rejected the worker token/);
  });

  it('refuses a broken program setting before it takes a job', async () => {
    const { audio } = await recording();
    const r = await runWorker(workerHome({ ffmpeg: '' }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/worker\.ffmpeg .* must be a program path/);
    expect(await jobOf(audio.id)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('gives the job back and stops when ffmpeg cannot be started', async () => {
    const { audio } = await recording();
    const home = workerHome();
    // Windows refuses to start a .cmd file without a shell (EINVAL); elsewhere a file without the execute bit (EACCES).
    const shim = join(oddFolder(home), 'ffmpeg.cmd');
    writeFileSync(shim, '@echo off\r\n');
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ ...config, worker: { ...config.worker, ffmpeg: shim } }));
    const r = await runWorker(home);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/could not be started/);
    expect(r.stdout).toMatch(/tabula worker doctor/);
    expect(await jobOf(audio.id)).toMatchObject({ status: 'queued', attempts: 0 });
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
    expect((await runCli(['worker', 'setup', '--events'], { cwd: home, env: { TABULA_HOME: home } })).stderr).toMatch(/tabula worker setup does not take --events/);
  });
});

describe('a job while the worker stops (Ctrl+C)', () => {
  /** A node script standing in for ffmpeg or the transcriber: reads its input, writes `marker`, then runs `body`. */
  function program(body: string) {
    const dir = tempDir('tabula stop é ');
    const marker = join(dir, 'ran');
    const script = join(dir, 'program.mjs');
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst marker = ${JSON.stringify(marker)};\nfor await (const _ of process.stdin);\n${body}\n`,
    );
    return { script, marker };
  }

  /** Claim the next job and run it in this process with `script` as the transcriber or as ffmpeg. */
  async function start(which: 'transcriber' | 'ffmpeg', script: string, { stopped = false } = {}) {
    const { audio } = await recording();
    const claim = await fetch(`${server.url}/api/worker/jobs/claim`, {
      method: 'POST', headers: { authorization: `Bearer ${TEST_WORKER_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ wait: 0 }),
    });
    expect(claim.status).toBe(200);
    const job = (await claim.json()) as Job;
    const cfg = {
      ...cli.WORKER_DEFAULTS, url: server.url, token: TEST_WORKER_TOKEN, python: process.execPath,
      script: which === 'transcriber' ? script : FAKE_TRANSCRIBE,
      ffmpeg: [process.execPath, which === 'ffmpeg' ? script : FAKE_FFMPEG],
    };
    const stop = new AbortController();
    if (stopped) stop.abort();
    const lines: string[] = [];
    const outcome = cli.runJob(cfg, job, { log: (line) => lines.push(line), stop: stop.signal });
    return { audio, stop, lines, outcome };
  }

  async function expectReleased(run: Awaited<ReturnType<typeof start>>) {
    expect(await run.outcome).toBe('released');
    expect(run.lines.join('\n')).toMatch(/stopped; the job went back to the queue/);
    expect(await jobOf(run.audio.id)).toMatchObject({ status: 'queued', attempts: 0, leaseId: null });
  }

  it.each([
    ['transcriber', 1],
    ['ffmpeg', 255],
  ] as const)('gives the job back when the %s exits with an error just before the stop', async (which, code) => {
    // A terminal Ctrl+C reaches ffmpeg and the transcriber too: one may exit (with an error) before the worker sees it.
    const { script, marker } = program(`writeFileSync(marker, '');\nprocess.stderr.write('KeyboardInterrupt\\n');\nprocess.exit(${code});`);
    const run = await start(which, script);
    await until(async () => existsSync(marker));
    await new Promise((r) => setTimeout(r, 300)); // the program has exited by now
    run.stop.abort();
    await expectReleased(run);
  });

  it('kills the transcriber and gives the job back when the stop comes first', async () => {
    const { script, marker } = program(`writeFileSync(marker, '');\nsetInterval(() => {}, 1000);`);
    const run = await start('transcriber', script);
    await until(async () => existsSync(marker));
    const stopped = Date.now();
    run.stop.abort();
    await expectReleased(run);
    expect(Date.now() - stopped).toBeLessThan(5000);
  });

  it('gives a job back that arrived after the stop (Ctrl+C while the claim was answered)', async () => {
    const { script, marker } = program(`writeFileSync(marker, '');`);
    const run = await start('transcriber', script, { stopped: true });
    await expectReleased(run);
    expect(existsSync(marker)).toBe(false);
  });

  // A venv's python.exe on Windows starts the real interpreter as its child; that one must end too. detached: node
  // would otherwise put the child in a job object that ends it together with its parent, which hides the problem.
  it.runIf(process.platform === 'win32')('kills what the transcriber started, too', async () => {
    const { script, marker } = program(
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: true, windowsHide: true });\nwriteFileSync(marker, String(child.pid));\nsetInterval(() => {}, 1000);`,
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let pid = 0;
    try {
      const run = await start('transcriber', script);
      await until(async () => existsSync(marker) && readFileSync(marker, 'utf8') !== '');
      pid = Number(readFileSync(marker, 'utf8'));
      expect(alive(pid)).toBe(true);
      run.stop.abort();
      await expectReleased(run);
      await until(async () => !alive(pid), 5000);
    } finally {
      if (pid && alive(pid)) process.kill(pid);
    }
  });
});

describe('tabula worker doctor and setup', () => {
  const run = (home: string, args: string[], env: Record<string, string> = {}, input?: string) =>
    runCli(['worker', ...args], {
      cwd: home,
      env: { TABULA_HOME: home, TABULA_DATA_DIR: join(home, 'data'), TABULA_URL: undefined, TABULA_TOKEN: undefined, TABULA_WORKER_TOKEN: undefined, ...env },
      input,
    });

  it('doctor passes with a working setup and runs a test transcription', async () => {
    const r = await run(workerHome(), ['doctor']);
    expect(r.stdout).toMatch(/^ok\s+.*accepts the worker token; 0 job\(s\) waiting/m);
    expect(r.stdout).toMatch(/^ok\s+ffmpeg: ffmpeg version 0\.0-fake/m);
    expect(r.stdout).toMatch(/^ok\s+Python 3\.14\.0, faster-whisper 1\.2\.1, CTranslate2 4\.8\.4/m);
    expect(r.stdout).toMatch(/^ok\s+CUDA: 1 device\(s\), float16 supported/m);
    expect(r.stdout).toMatch(/^ok\s+test transcription with large-v3 on cuda: [\d.]+ s/m);
    expect(r.code).toBe(0);
  });

  it('doctor is no sign of life of the worker (the tray must not take it for a running one)', async () => {
    const home = workerHome();
    expect((await run(home, ['doctor'])).code).toBe(0);
    const q = await run(home, ['queue', '--json']);
    expect(JSON.parse(q.stdout)).toMatchObject({ ok: true, worker_last_seen: null });
  });

  it('doctor checks an older server without the queue endpoint through ping', async () => {
    const proxy = await startProxy(server.url, (url) => (url.startsWith('/api/worker/queue') ? { status: 404 } : 0));
    try {
      const r = await run(workerHome({ url: proxy.url }), ['doctor']);
      expect(r.stdout).toMatch(/^ok\s+.*accepts the worker token; 0 job\(s\) waiting/m);
      expect(r.code).toBe(0);
    } finally {
      proxy.close();
    }
  });

  it('doctor names a missing CUDA device and skips the test transcription', async () => {
    const r = await run(workerHome(), ['doctor'], { FAKE_TRANSCRIBE_CUDA: '0' });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^FAIL\s+CTranslate2 sees no CUDA device/m);
    expect(r.stdout).toMatch(/^skip\s+test transcription/m);
  });

  it('doctor says what to do without a Python environment or a token', async () => {
    const r = await run(workerHome({ python: '', token: '' }), ['doctor']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^FAIL\s+no server URL or worker token\n\s+run tabula worker setup/m);
    expect(r.stdout).toMatch(/^FAIL\s+no Python environment for transcription\n\s+run tabula worker setup/m);
  });

  it('setup checks the worker token before it installs anything', async () => {
    const home = tempDir('tabula home ');
    const r = await run(home, ['setup', server.url, '--token-stdin'], {}, TEST_TOKEN);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/rejected the worker token/);
    expect(existsSync(join(home, 'data', 'whisper'))).toBe(false);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  it('setup without a URL explains how to give one', async () => {
    const r = await run(tempDir('tabula home '), ['setup', '--token-stdin'], {}, TEST_WORKER_TOKEN);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/usage: tabula worker setup <url>/);
  });

  it('setup reports an unreachable server as an error line, not a stack trace', async () => {
    const r = await run(tempDir('tabula home '), ['setup', 'http://127.0.0.1:9', '--token-stdin'], {}, TEST_WORKER_TOKEN);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^tabula: cannot reach http:\/\/127\.0\.0\.1:9/);
    expect(r.stderr).not.toMatch(/unexpected error/);
  });

  it('setup never sends a stored token to another URL and never takes the token from the environment', async () => {
    const home = workerHome({ url: 'http://127.0.0.1:9' }); // a valid token, stored for a different URL
    const other = await run(home, ['setup', server.url]);
    expect(other.code).toBe(1);
    expect(other.stderr).toMatch(/no worker token given/);
    const viaEnv = await run(workerHome({ token: '' }), ['setup', server.url], { TABULA_WORKER_TOKEN: TEST_WORKER_TOKEN });
    expect(viaEnv.code).toBe(1);
    expect(viaEnv.stderr).toMatch(/no worker token given/);
    expect(existsSync(join(home, 'data', 'whisper'))).toBe(false);
  });

  it('pins the versions of the worker packages', () => {
    expect(cli.WHISPER_PACKAGES).toEqual(['faster-whisper>=1.2.1,<2', 'ctranslate2>=4.8.4,<5', 'nvidia-cublas-cu12>=12.9,<13', 'nvidia-cudnn-cu12>=9,<10']);
  });

  it('refuses --token-stdin on a plain worker run', async () => {
    const r = await run(workerHome(), ['--token-stdin']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/tabula worker does not take --token-stdin/);
  });
});

describe('tabula worker queue', () => {
  const queue = (home: string, args: string[] = ['--json']) =>
    runCli(['worker', 'queue', ...args], {
      cwd: home,
      env: { TABULA_HOME: home, TABULA_DATA_DIR: join(home, 'data'), TABULA_URL: undefined, TABULA_TOKEN: undefined, TABULA_WORKER_TOKEN: undefined },
    });
  /** The one JSON line of a --json run, which always exits 0. */
  const json = (r: RunResult) => {
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    return JSON.parse(r.stdout);
  };

  it("prints what waits and when this computer's worker was last seen, without being seen itself", async () => {
    await recording();
    const home = workerHome();
    expect(json(await queue(home))).toEqual({ ok: true, server: server.url, queued: 1, running: 0, worker_last_seen: null });
    expect((await runWorker(home)).code).toBe(0);
    const after = json(await queue(home));
    expect(after).toMatchObject({ ok: true, queued: 0, running: 0 });
    expect(Date.now() - Date.parse(after.worker_last_seen)).toBeLessThan(10_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(json(await queue(home)).worker_last_seen).toBe(after.worker_last_seen);
  });

  it('reports a missing setup, a rejected token and no answer as JSON with exit 0', async () => {
    expect(json(await queue(tempDir('tabula home ')))).toMatchObject({ ok: false, error: 'config', message: expect.stringMatching(/tabula worker setup/) });
    expect(json(await queue(workerHome({ token: TEST_TOKEN })))).toMatchObject({ ok: false, error: 'rejected', message: expect.stringMatching(/rejected the worker token/) });
    expect(json(await queue(workerHome({ url: 'http://127.0.0.1:9' })))).toMatchObject({
      ok: false, error: 'unreachable', message: expect.stringMatching(/cannot reach http:\/\/127\.0\.0\.1:9/),
    });
  });

  it('says that a server without TABULA_WORKER_TOKEN has no worker API', async () => {
    const off = await buildApp({ config: testConfig({ workerToken: undefined }), db });
    await off.listen({ port: 0, host: '127.0.0.1' });
    try {
      const url = `http://127.0.0.1:${(off.server.address() as AddressInfo).port}`;
      expect(json(await queue(workerHome({ url })))).toMatchObject({ ok: false, error: 'disabled', message: expect.stringMatching(/TABULA_WORKER_TOKEN/) });
    } finally {
      await off.close();
    }
  });

  it('asks for a server update when the server does not know the queue endpoint', async () => {
    const proxy = await startProxy(server.url, (url) => (url.startsWith('/api/worker/queue') ? { status: 404 } : 0));
    try {
      expect(json(await queue(workerHome({ url: proxy.url })))).toMatchObject({
        ok: false, error: 'unreachable', message: expect.stringMatching(/update the Tabula server/),
      });
    } finally {
      proxy.close();
    }
  });

  it('prints one line for people, and an error with exit 1', async () => {
    await recording();
    const ok = await queue(workerHome(), []);
    expect(ok.code).toBe(0);
    expect(ok.stdout.trim()).toBe(`1 waiting, 0 being transcribed on ${server.url}`);
    const bad = await queue(tempDir('tabula home '), []);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/^tabula: no server URL: run tabula worker setup/);
  });
});

type WorkerEvent = { type: string; time: string; [key: string]: unknown };

/**
 * tabula worker --events with its standard input kept open (runCli closes it at once, which means "stop" here).
 * `events()` parses the complete lines so far and throws on any stdout line that is not JSON.
 */
function startEvents(home: string, args: string[], env: Record<string, string> = {}) {
  const tmp = join(oddFolder(home), 'tmp');
  const childEnv: Record<string, string | undefined> = {
    ...process.env, TABULA_HOME: home, TABULA_DATA_DIR: join(home, 'data'), TABULA_URL: undefined, TABULA_TOKEN: undefined,
    TABULA_WORKER_TOKEN: undefined, FAKE_TRANSCRIBE_LOG: join(home, 'transcriber.log'), TEMP: tmp, TMP: tmp, TMPDIR: tmp, ...env,
  };
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
  const child = spawn(process.execPath, [CLI, 'worker', ...args], { cwd: home, env: childEnv, windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    stdout += d;
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr += d;
  });
  const done = new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
  const events = (): WorkerEvent[] => {
    const lines = stdout.split('\n');
    lines.pop(); // the line still being written, or the empty rest after the last line break
    return lines.map((line) => JSON.parse(line) as WorkerEvent);
  };
  return {
    events,
    /** The event types without the log lines. */
    types: () => events().filter((e) => e.type !== 'log').map((e) => e.type),
    waitFor: (check: (e: WorkerEvent) => boolean) => until(async () => events().some(check)),
    send: (line: string) => void child.stdin.write(`${line}\n`),
    end: () => void child.stdin.end(),
    /** Stop reading the events: the worker's next writes to stdout fail (a tray that crashed). */
    hangUp: () => void child.stdout.destroy(),
    stdout: () => stdout,
    done,
  };
}

/** A proxy in front of the test server that holds back every request whose path ends with `slowPath`. */
async function slowProxy(slowPath: string, ms: number) {
  const proxy = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if ((req.url ?? '').split('?')[0]!.endsWith(slowPath)) await new Promise((r) => setTimeout(r, ms));
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))) as Record<string, string>;
      try {
        const up = await fetch(server.url + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/octet-stream' }).end(Buffer.from(await up.arrayBuffer()));
      } catch {
        res.destroy();
      }
    })();
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    close: () => {
      proxy.closeAllConnections();
      proxy.close();
    },
  };
}

describe('tabula worker --events', () => {
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
  const transcribing = (e: WorkerEvent) => e.type === 'phase' && e.phase === 'transcribe';

  it('sends one JSON line per event for a transcribed job and nothing else on stdout', async () => {
    const { report } = await recording();
    const home = workerHome();
    const run = startEvents(home, ['--once', '--events']);
    const r = await run.done;
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(run.stdout().endsWith('\n')).toBe(true);
    const events = run.events();
    for (const e of events) expect(e.time).toMatch(ISO);
    expect(run.types()).toEqual(['started', 'idle', 'job', 'phase', 'phase', 'phase', 'progress', 'phase', 'done', 'idle', 'stopped']);
    const of = (type: string) => events.filter((e) => e.type === type);
    expect(of('started')[0]).toMatchObject({ version: '1.3.0', once: true, server: server.url });
    expect(of('job')[0]).toMatchObject({
      attempt: 1,
      attachment: { kind: 'audio', size: 32044, file_name: 'voice.wav' },
      report: { id: report.id, project: 'demo', title: 'Player freezes' },
      report_url: `${server.url}/#/reports/${report.id}?project=demo`,
    });
    const id = of('job')[0]!.id;
    expect(of('phase').map((e) => e.phase)).toEqual(['download', 'extract', 'transcribe', 'upload']);
    // The fake transcriber reports 400 and 800 ms within one second: only the first becomes an event.
    expect(of('progress')).toMatchObject([{ id, done_ms: 400, total_ms: 1000 }]);
    expect(of('done')).toMatchObject([{ id, segments: 2 }]);
    expect(of('stopped')).toMatchObject([{ done: 1, failed: 0, code: 0 }]);
    expect(of('log').map((e) => e.text).join('\n')).toMatch(/done in [\d.]+ s, 2 segments/);
    for (const secret of [TEST_TOKEN, TEST_WORKER_TOKEN, 'Ahoj', 'tlačidlo']) expect(run.stdout()).not.toContain(secret);
    expect(readFileSync(join(home, 'data', 'worker.log'), 'utf8')).toMatch(/done in [\d.]+ s, 2 segments/);
  });

  it('reports a failed job with its retry time', async () => {
    const { audio } = await recording();
    const run = startEvents(workerHome(), ['--once', '--events'], { FAKE_TRANSCRIBE: 'fail' });
    expect((await run.done).code).toBe(0);
    const failed = run.events().find((e) => e.type === 'failed');
    expect(failed).toMatchObject({ message: 'transcription failed (exit 1): Traceback: boom' });
    expect(String(failed!.retry_at)).toMatch(ISO);
    expect(run.types().slice(-3)).toEqual(['failed', 'idle', 'stopped']);
    expect(run.events().at(-1)).toMatchObject({ type: 'stopped', done: 0, failed: 1, code: 0 });
    expect(await jobOf(audio.id)).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('names a broken GPU setup, a missing setup and a rejected token in an error event before stopped', async () => {
    const { audio } = await recording();
    let run = startEvents(workerHome(), ['--once', '--events'], { FAKE_TRANSCRIBE: 'env' });
    expect((await run.done).code).toBe(1);
    expect(run.events().find((e) => e.type === 'error')).toMatchObject({ kind: 'environment', message: expect.stringMatching(/CUDA is not available/) });
    expect(run.events().at(-1)).toMatchObject({ type: 'stopped', code: 1 });
    expect(await jobOf(audio.id)).toMatchObject({ status: 'queued', attempts: 0 });

    run = startEvents(tempDir('tabula home '), ['--events']);
    const r = await run.done;
    expect(r.code).toBe(1);
    expect(run.types()).toEqual(['error', 'stopped']);
    expect(run.events().find((e) => e.type === 'error')).toMatchObject({ kind: 'config', message: expect.stringMatching(/tabula worker setup/) });
    expect(r.stderr).toMatch(/^tabula: no server URL/);

    run = startEvents(workerHome({ token: TEST_TOKEN }), ['--events']);
    expect((await run.done).code).toBe(1);
    expect(run.events().find((e) => e.type === 'error')).toMatchObject({ kind: 'rejected' });
  });

  it.each(['stop', 'end of input'] as const)('gives the job back on %s', async (how) => {
    const { audio } = await recording();
    const run = startEvents(workerHome(), ['--events'], { FAKE_TRANSCRIBE: 'slow' });
    await run.waitFor(transcribing);
    if (how === 'stop') run.send('stop');
    else run.end();
    const r = await run.done;
    expect(r.code).toBe(0);
    expect(run.types().slice(-2)).toEqual(['released', 'stopped']);
    expect(run.events().at(-1)).toMatchObject({ type: 'stopped', done: 0, failed: 0, code: 0 });
    expect(await jobOf(audio.id)).toMatchObject({ status: 'queued', attempts: 0, leaseId: null });
  });

  it('quits at once on a second "stop"', async () => {
    await recording();
    // The release waits at the proxy, so the first stop is still busy when the second one comes.
    const proxy = await slowProxy('/release', 5000);
    try {
      const run = startEvents(workerHome({ url: proxy.url }), ['--once', '--events'], { FAKE_TRANSCRIBE: 'slow' });
      await run.waitFor(transcribing);
      run.send('stop');
      await run.waitFor((e) => e.type === 'log' && /stopping/.test(String(e.text)));
      const second = Date.now();
      run.send('stop');
      const r = await run.done;
      expect(r.code).toBe(130);
      expect(Date.now() - second).toBeLessThan(3000);
      expect(run.events().at(-1)).toMatchObject({ type: 'stopped', code: 130 });
    } finally {
      proxy.close();
    }
  });

  it('keeps waiting through connection errors and stops on command', async () => {
    const run = startEvents(workerHome({ url: 'http://127.0.0.1:9' }), ['--events']);
    await run.waitFor((e) => e.type === 'error');
    expect(run.events().find((e) => e.type === 'error')).toMatchObject({ kind: 'connection', message: expect.stringMatching(/cannot reach/) });
    run.send('stop');
    expect((await run.done).code).toBe(0);
    expect(run.types().filter((t) => t !== 'error')).toEqual(['started', 'idle', 'stopped']);
  });

  it('ends --once with a connection error when the server cannot be reached', async () => {
    const run = startEvents(workerHome({ url: 'http://127.0.0.1:9' }), ['--once', '--events']);
    expect((await run.done).code).toBe(1);
    const events = run.events().filter((e) => e.type !== 'log');
    expect(events.slice(-2)).toMatchObject([
      { type: 'error', kind: 'connection', message: expect.stringMatching(/cannot reach http:\/\/127\.0\.0\.1:9/) },
      { type: 'stopped', code: 1 },
    ]);
  });

  it('finishes the job when nobody reads its events any more', async () => {
    const { audio } = await recording();
    const home = workerHome();
    // The slow transcriber reports progress again after 8 s (at the latest): that event goes to a closed pipe from
    // inside the handler of the transcriber's output, and must not end the worker.
    const run = startEvents(home, ['--once', '--events'], { FAKE_TRANSCRIBE: 'slow' });
    await run.waitFor(transcribing);
    run.hangUp();
    const r = await run.done;
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(await jobOf(audio.id)).toMatchObject({ status: 'done', attempts: 1 });
    expect(readFileSync(join(home, 'data', 'worker.log'), 'utf8')).toMatch(/worker stopped: 1 transcribed, 0 failed/);
  });
});

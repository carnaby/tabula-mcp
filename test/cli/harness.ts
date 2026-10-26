import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { buildApp } from '../../src/http/app.js';
import { testConfig } from '../helpers.js';

export const CLI = fileURLToPath(new URL('../../cli/tabula.mjs', import.meta.url));

/** A real Tabula server on an ephemeral port, for the CLI to talk to. */
export function useServer(db: Db): { url: string } {
  const server = { url: '' };
  let app: FastifyInstance | undefined;
  beforeAll(async () => {
    app = await buildApp({ config: testConfig(), db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    server.url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(() => app?.close());
  return server;
}

export type RunResult = { code: number; stdout: string; stderr: string; ms: number };

/** Async on purpose: spawnSync would block the event loop, and the server under test runs in this process. */
export function runCli(
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined>; input?: string; cli?: string },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    const child = spawn(process.execPath, [opts.cli ?? CLI, ...args], { cwd: opts.cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(opts.input ?? '');
  });
}

export const tempDir = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], {
    cwd, encoding: 'utf8',
  });
}

export function writeFile(root: string, path: string, content: string | Buffer): void {
  const abs = join(root, ...path.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export const readText = (root: string, path: string): string => readFileSync(join(root, ...path.split('/')), 'utf8');

/** A committed repository with .tabula.json and a .gitignore that hides docs/ and .env; `files` are left untracked. */
export function makeRepo(dir: string, tabulaJson: object, files: Record<string, string | Buffer> = {}): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, '.gitignore'), 'docs/\n.env\n');
  writeFileSync(join(dir, '.tabula.json'), JSON.stringify(tabulaJson));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);
  return dir;
}

/**
 * A proxy in front of the test server for the CLI's GET requests. `delay` returns how many ms to hold a request back,
 * or 'drop' to close the connection without an answer.
 */
export async function startProxy(
  target: string,
  delay: (url: string) => number | 'drop',
): Promise<{ url: string; close: () => void }> {
  const proxy = createServer((req, res) => {
    void (async () => {
      const d = delay(req.url ?? '');
      if (d === 'drop') return void res.destroy();
      if (d > 0) await new Promise((r) => setTimeout(r, d));
      try {
        const r = await fetch(target + req.url, { method: req.method, headers: { authorization: String(req.headers.authorization) } });
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
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

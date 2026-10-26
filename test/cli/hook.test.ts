import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedProject, TEST_TOKEN, useTestDb } from '../helpers.js';
import { CLI, git, makeRepo, readText, runCli, tempDir, useServer } from './harness.js';

const db = useTestDb();
const server = useServer(db);
let home: string;
const env = () => ({ TABULA_HOME: home, TABULA_URL: server.url, TABULA_TOKEN: TEST_TOKEN });
const cfg = { project: 'demo', sync: ['docs/**'] };

beforeEach(async () => {
  await seedProject(db, 'demo');
  home = tempDir('tabula-home-');
});

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('tabula pull --hook', { timeout: 60_000 }, () => {
  it('exits 0 silently without credentials, without .tabula.json and outside a repository', async () => {
    const a = makeRepo(tempDir('tabula-h-'), cfg);
    const quiet = { code: 0, stdout: '', stderr: '' };
    expect(await runCli(['pull', '--hook'], { cwd: a, env: { TABULA_HOME: home, TABULA_URL: undefined, TABULA_TOKEN: undefined } }))
      .toMatchObject(quiet);
    const bare = tempDir('tabula-h2-');
    git(bare, 'init', '-q');
    expect(await runCli(['pull', '--hook'], { cwd: bare, env: env() })).toMatchObject(quiet);
    const plain = tempDir('tabula-h3-');
    expect(await runCli(['pull', '--hook'], { cwd: plain, env: { ...env(), GIT_CEILING_DIRECTORIES: dirname(plain) } }))
      .toMatchObject(quiet);
  });

  it('restores missing files with one line on stdout, and says nothing when there is nothing to do', async () => {
    const root = tempDir('tabula-h4-');
    const a = makeRepo(join(root, 'a'), cfg, { 'docs/handoff/state.md': 'state' });
    expect((await runCli(['push'], { cwd: a, env: env() })).code).toBe(0);
    const b = join(root, 'b');
    git(root, 'clone', '-q', a, b);
    const first = await runCli(['pull', '--hook'], { cwd: b, env: env() });
    expect(first.code).toBe(0);
    expect(first.stdout.trim().split('\n')).toEqual(['tabula: restored 1 file from Tabula project demo']);
    expect(readText(b, 'docs/handoff/state.md')).toBe('state');
    expect(await runCli(['pull', '--hook'], { cwd: b, env: env() })).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('exits 0 within 5 s with one stderr line when the server is unreachable', async () => {
    const a = makeRepo(tempDir('tabula-h5-'), cfg);
    const r = await runCli(['pull', '--hook'], { cwd: a, env: { ...env(), TABULA_URL: `http://127.0.0.1:${await closedPort()}` } });
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(5000);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toMatch(/^tabula: cannot reach/);
  });

  it('exits 0 within 5 s when the server accepts the connection but never answers', async () => {
    const sockets = new Set<Socket>();
    const hang = createServer((s) => void sockets.add(s)); // never writes a byte
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    try {
      const a = makeRepo(tempDir('tabula-h6-'), cfg);
      const url = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
      const r = await runCli(['pull', '--hook'], { cwd: a, env: { ...env(), TABULA_URL: url } });
      expect(r.code).toBe(0);
      expect(r.ms).toBeLessThan(5000);
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).toMatch(/^tabula: /);
    } finally {
      for (const s of sockets) s.destroy();
      hang.close();
    }
  });

  it('exits 0 with one stderr line on a broken .tabula.json', async () => {
    const a = makeRepo(tempDir('tabula-h7-'), cfg);
    writeFileSync(join(a, '.tabula.json'), '{ not json');
    const r = await runCli(['pull', '--hook'], { cwd: a, env: env() });
    expect(r.code).toBe(0);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toMatch(/\.tabula\.json is not valid JSON/);
  });
});

describe('tabula install, update and the version check', { timeout: 60_000 }, () => {
  it('install copies the CLI into TABULA_HOME, writes the shims and prints the hook for this machine', async () => {
    const r = await runCli(['install'], { cwd: tempDir('tabula-i-'), env: { TABULA_HOME: home } });
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(home, 'tabula.mjs'), 'utf8')).toBe(readFileSync(CLI, 'utf8'));
    expect(readFileSync(join(home, 'bin', 'tabula'), 'utf8')).toMatch(/^#!\/bin\/sh\nexec node ".*tabula\.mjs" "\$@"\n$/);
    expect(readFileSync(join(home, 'bin', 'tabula.cmd'), 'utf8')).toContain('tabula.mjs" %*');
    const hook = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    expect(hook.hooks.SessionStart[0].hooks[0]).toMatchObject({
      type: 'command', command: expect.stringMatching(/^node ".*\/tabula\.mjs" pull --hook$/), timeout: 10,
    });
  });

  it('warns when the server offers another version, and update replaces the file with the served one', async () => {
    mkdirSync(home, { recursive: true });
    const copy = join(home, 'tabula.mjs');
    writeFileSync(copy, readFileSync(CLI, 'utf8').replace(/^export const VERSION = '[^']+';(?=\r?$)/m, "export const VERSION = '0.0.1';"));
    const a = makeRepo(tempDir('tabula-u-'), cfg);
    const st = await runCli(['status'], { cwd: a, env: env(), cli: copy });
    expect(st.code).toBe(0);
    expect(st.stderr).toMatch(/the server offers tabula \S+ \(you have 0\.0\.1\); run tabula update/);
    const up = await runCli(['update'], { cwd: a, env: env(), cli: copy });
    expect(up.code, up.stderr).toBe(0);
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(CLI, 'utf8'));
    expect((await runCli(['status'], { cwd: a, env: env(), cli: copy })).stderr).toBe('');
  });
});

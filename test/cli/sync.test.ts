import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { projectFiles } from '../../src/db/schema.js';
import { getFile, listFiles, putFile } from '../../src/domain/files.js';
import { seedProject, TEST_TOKEN, useTestDb } from '../helpers.js';
import { git, makeRepo, readText, runCli, tempDir, useServer, writeFile } from './harness.js';

const db = useTestDb();
const server = useServer(db);
let home: string;
const env = () => ({ TABULA_HOME: home, TABULA_URL: server.url, TABULA_TOKEN: TEST_TOKEN });
const noCreds = () => ({ TABULA_HOME: home, TABULA_URL: undefined, TABULA_TOKEN: undefined });
const cfg = { project: 'demo', sync: ['docs/**'], state: ['docs/handoff/*.md'] };
const serverPaths = async (project = 'demo') => (await listFiles(db, project)).map((f) => f.path);

beforeEach(async () => {
  await seedProject(db, 'demo');
  home = tempDir('tabula-home-');
});

describe('tabula push and pull', { timeout: 60_000 }, () => {
  it('restores pushed files byte for byte in a fresh clone (BOM, CRLF, spaces, diacritics, run from a subfolder)', async () => {
    const root = tempDir('tabula-a-');
    const a = makeRepo(join(root, 'a'), cfg, {
      'docs/handoff/state.md': '# State\nNext: CLI\n',
      'docs/plány/stav s medzerou.md': Buffer.from(`${String.fromCharCode(0xfeff)}# Plán\r\nčítaj\r\n`, 'utf8'),
    });
    const push = await runCli(['push'], { cwd: join(a, 'docs'), env: env() });
    expect(push.code, push.stderr).toBe(0);
    expect(await serverPaths()).toEqual(['docs/handoff/state.md', 'docs/plány/stav s medzerou.md']);
    expect((await listFiles(db, 'demo')).find((f) => f.path === 'docs/handoff/state.md')?.isState).toBe(true);
    expect((await runCli(['status'], { cwd: a, env: env() })).stdout).toMatch(/everything in sync \(2 files\)/);

    const b = join(root, 'b');
    git(root, 'clone', '-q', a, b);
    const pull = await runCli(['pull'], { cwd: b, env: env() });
    expect(pull.code, pull.stderr).toBe(0);
    for (const p of ['docs/handoff/state.md', 'docs/plány/stav s medzerou.md']) {
      expect(readFileSync(join(b, ...p.split('/')))).toEqual(readFileSync(join(a, ...p.split('/'))));
    }
    expect((await runCli(['status'], { cwd: b, env: env() })).stdout).toMatch(/everything in sync/);
  });

  it('never uploads tracked files, even when a sync pattern matches them', async () => {
    const a = makeRepo(tempDir('tabula-t-'), { project: 'demo', sync: ['notes/**'] }, {
      'notes/tracked.md': 'tracked', 'notes/untracked.md': 'untracked',
    });
    git(a, 'add', 'notes/tracked.md');
    git(a, 'commit', '-q', '-m', 'track one');
    expect((await runCli(['push'], { cwd: a, env: env() })).code).toBe(0);
    expect(await serverPaths()).toEqual(['notes/untracked.md']);
  });

  it('updates unchanged copies, reports conflicts with exit code 2, and --force resolves them', async () => {
    const root = tempDir('tabula-c-');
    const a = makeRepo(join(root, 'a'), cfg, { 'docs/plan.md': 'v1\n' });
    expect((await runCli(['push'], { cwd: a, env: env() })).code).toBe(0);
    const b = join(root, 'b');
    git(root, 'clone', '-q', a, b);
    expect((await runCli(['pull'], { cwd: b, env: env() })).code).toBe(0);

    writeFile(a, 'docs/plan.md', 'v2\n');
    expect((await runCli(['push'], { cwd: a, env: env() })).code).toBe(0);
    expect((await runCli(['pull'], { cwd: b, env: env() })).code).toBe(0);
    expect(readText(b, 'docs/plan.md')).toBe('v2\n');

    writeFile(a, 'docs/plan.md', 'from A\n');
    writeFile(b, 'docs/plan.md', 'from B\n');
    expect((await runCli(['push'], { cwd: a, env: env() })).code).toBe(0);
    const pushB = await runCli(['push'], { cwd: b, env: env() });
    expect(pushB.code).toBe(2);
    expect(pushB.stderr).toMatch(/conflict docs\/plan\.md/);
    expect((await getFile(db, 'demo', 'docs/plan.md')).content).toBe('from A\n');
    expect((await runCli(['pull'], { cwd: b, env: env() })).code).toBe(2);
    expect(readText(b, 'docs/plan.md')).toBe('from B\n');
    expect((await runCli(['status'], { cwd: b, env: env() })).code).toBe(2);

    expect((await runCli(['push', '--force'], { cwd: b, env: env() })).code).toBe(0);
    expect((await getFile(db, 'demo', 'docs/plan.md')).content).toBe('from B\n');

    writeFile(a, 'docs/plan.md', 'A again\n');
    expect((await runCli(['pull'], { cwd: a, env: env() })).code).toBe(2);
    expect((await runCli(['pull', '--force'], { cwd: a, env: env() })).code).toBe(0);
    expect(readText(a, 'docs/plan.md')).toBe('from B\n');
  });

  it('skips binary, oversized and non-UTF-8 files and refuses .env files, with warnings', async () => {
    const a = makeRepo(tempDir('tabula-s-'), { project: 'demo', sync: ['docs/**', '.env', 'config/**'] }, {
      'docs/ok.md': 'fine',
      'docs/image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      'docs/huge.md': 'x'.repeat(1_048_577),
      'docs/latin1.md': Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      '.env': 'TOKEN=secret',
      'config/.env.local': 'TOKEN=secret',
    });
    const r = await runCli(['push'], { cwd: a, env: env() });
    expect(r.code).toBe(0);
    expect(await serverPaths()).toEqual(['docs/ok.md']);
    expect(r.stderr).toMatch(/skip docs\/image\.png: binary/);
    expect(r.stderr).toMatch(/skip docs\/huge\.md: larger than 1 MiB/);
    expect(r.stderr).toMatch(/skip docs\/latin1\.md: not valid UTF-8/);
    expect(r.stderr).toMatch(/skip \.env: \.env files are never synced/);
    expect(r.stderr).toMatch(/skip config\/\.env\.local: \.env files are never synced/);
  });

  it('skips local paths Tabula would refuse (control characters, over 512 characters) with a warning, not a failure', async () => {
    const long = `docs/${'a'.repeat(254)}/${'b'.repeat(251)}.md`;
    const tab = `docs/tab${String.fromCharCode(9)}name.md`;
    const files: Record<string, string> = { 'docs/ok.md': 'fine', [long]: 'long' };
    if (process.platform !== 'win32') files[tab] = 'tab'; // Windows file names cannot hold control characters
    const a = makeRepo(tempDir('tabula-o-'), cfg, files);
    git(a, 'config', 'core.longpaths', 'true'); // Git for Windows lists paths over 260 characters only with this
    const r = await runCli(['push'], { cwd: a, env: env() });
    expect(r.code, r.stderr).toBe(0);
    expect(await serverPaths()).toEqual(['docs/ok.md']);
    const reason = 'path not accepted by Tabula (control characters or over 512 characters)';
    expect(r.stderr).toContain(`skip ${long}: ${reason}`);
    if (process.platform !== 'win32') expect(r.stderr).toContain(`skip ${tab}: ${reason}`);
  });

  it('never writes a server path that is unsafe on disk (.GIT/hooks, the 8.3 name GIT~1, control characters)', async () => {
    // "**" matches every path, so the safety check (not the sync filter) is what keeps these off the disk.
    const a = makeRepo(tempDir('tabula-u-'), { project: 'demo', sync: ['**'] });
    const hook = '.GIT/hooks/post-checkout';
    const shortName = 'GIT~1/hooks/post-checkout'; // on Windows, the 8.3 short name of .git
    const tab = `docs/tab${String.fromCharCode(9)}name.md`;
    const script = '#!/bin/sh\necho owned\n';
    // The server refuses such paths itself, so they can only come from a damaged or older database.
    const put = await fetch(`${server.url}/api/projects/demo/files`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: hook, content: script, base_sha256: null }),
    });
    expect(put.status).toBe(400);
    const putShort = await fetch(`${server.url}/api/projects/demo/files`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: shortName, content: script, base_sha256: null }),
    });
    expect(putShort.status).toBe(400);
    const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
    await db.insert(projectFiles).values([hook, shortName, tab].map((path) => ({
      projectId: 'demo', path, content: script, sha256: sha(script), size: Buffer.byteLength(script), updatedBy: 'test',
    })));
    await putFile(db, 'demo', { path: 'docs/ok.md', content: 'ok', baseSha256: null }, 'test');

    const pull = await runCli(['pull'], { cwd: a, env: env() });
    expect(pull.code, pull.stderr).toBe(0);
    expect(pull.stderr).toContain(`skip ${hook}: unsafe path on the server, ignored`);
    expect(pull.stderr).toContain(`skip ${shortName}: unsafe path on the server, ignored`);
    expect(pull.stderr).toContain(`skip ${tab}: unsafe path on the server, ignored`);
    expect(readText(a, 'docs/ok.md')).toBe('ok');
    expect(existsSync(join(a, '.git', 'hooks', 'post-checkout'))).toBe(false);
    expect(existsSync(join(a, '.GIT', 'hooks', 'post-checkout'))).toBe(false);
    expect(existsSync(join(a, 'GIT~1', 'hooks', 'post-checkout'))).toBe(false);
    expect(existsSync(join(a, ...tab.split('/')))).toBe(false);
  });

  it('refuses to write through a directory link into .git or out of the repository', async () => {
    const root = tempDir('tabula-j-');
    const a = makeRepo(join(root, 'a'), cfg, { 'docs/keep.md': 'keep' });
    const outside = join(root, 'outside');
    mkdirSync(outside);
    // Junctions need no privileges on Windows; elsewhere the type is ignored and a directory symlink is made.
    symlinkSync(join(a, '.git'), join(a, 'docs', 'gitlink'), 'junction');
    symlinkSync(outside, join(a, 'docs', 'outlink'), 'junction');
    for (const path of ['docs/gitlink/hooks/post-checkout', 'docs/outlink/x.md', 'docs/ok.md']) {
      await putFile(db, 'demo', { path, content: '#!/bin/sh\n', baseSha256: null }, 'test');
    }
    const pull = await runCli(['pull'], { cwd: a, env: env() });
    expect(pull.code, pull.stderr).toBe(0);
    expect(pull.stderr).toMatch(/skip docs\/gitlink\/hooks\/post-checkout: .*inside the git directory/);
    expect(pull.stderr).toMatch(/skip docs\/outlink\/x\.md: .*outside the repository/);
    expect(readText(a, 'docs/ok.md')).toBe('#!/bin/sh\n');
    expect(existsSync(join(a, '.git', 'hooks', 'post-checkout'))).toBe(false);
    expect(existsSync(join(outside, 'x.md'))).toBe(false);
  });

  it('pulls only server files that match this clone\'s sync patterns', async () => {
    const a = makeRepo(tempDir('tabula-m-'), cfg);
    await putFile(db, 'demo', { path: '.vscode/tasks.json', content: '{"tasks":[]}', baseSha256: null }, 'test');
    await putFile(db, 'demo', { path: 'docs/ok.md', content: 'ok', baseSha256: null }, 'test');
    const pull = await runCli(['pull'], { cwd: a, env: env() });
    expect(pull.code, pull.stderr).toBe(0);
    expect(readText(a, 'docs/ok.md')).toBe('ok');
    expect(existsSync(join(a, '.vscode', 'tasks.json'))).toBe(false);
    expect(pull.stderr).not.toMatch(/tasks\.json/);
    const st = await runCli(['status'], { cwd: a, env: env() });
    expect(st.stdout).toMatch(/not matched\s+\.vscode\/tasks\.json \(on server, not matched by sync\)/);
  });

  it('gives each worktree its own project (the folder name) and its own sync state', async () => {
    await seedProject(db, 'core');
    await seedProject(db, 'core-station');
    const root = tempDir('tabula-w-');
    const core = makeRepo(join(root, 'core'), { sync: ['docs/**'] }, { 'docs/handoff/state.md': 'core state' });
    const station = join(root, 'core-station');
    git(core, 'worktree', 'add', '-q', '-b', 'station', station);
    writeFile(station, 'docs/handoff/state.md', 'station state');
    expect((await runCli(['push'], { cwd: core, env: env() })).code).toBe(0);
    expect((await runCli(['push'], { cwd: station, env: env() })).code).toBe(0);
    expect((await getFile(db, 'core', 'docs/handoff/state.md')).content).toBe('core state');
    expect((await getFile(db, 'core-station', 'docs/handoff/state.md')).content).toBe('station state');
    expect((await listFiles(db, 'core'))[0]!.isState).toBe(true); // default state patterns
    const mainState = JSON.parse(readFileSync(join(core, '.git', 'tabula-sync.json'), 'utf8'));
    const wtState = JSON.parse(readFileSync(join(core, '.git', 'worktrees', 'core-station', 'tabula-sync.json'), 'utf8'));
    expect([mainState.project, wtState.project]).toEqual(['core', 'core-station']);
    expect(git(core, 'status', '--porcelain')).toBe('');
  });
});

describe('tabula login, status, rm and errors', { timeout: 60_000 }, () => {
  it('logs in with a token from stdin, refuses a wrong token, and works without the environment afterwards', async () => {
    const a = makeRepo(tempDir('tabula-l-'), cfg, { 'docs/a.md': 'a' });
    const bad = await runCli(['login', server.url, '--token-stdin'], { cwd: a, env: noCreds(), input: 'wrong-token\n' });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/rejected the token/);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
    const ok = await runCli(['login', `${server.url}/`, '--token-stdin'], { cwd: a, env: noCreds(), input: `${TEST_TOKEN}\n` });
    expect(ok.code, ok.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({ url: server.url, token: TEST_TOKEN });
    if (process.platform !== 'win32') expect(statSync(join(home, 'config.json')).mode & 0o777).toBe(0o600);
    expect((await runCli(['push'], { cwd: a, env: noCreds() })).code).toBe(0);
    expect(await serverPaths()).toEqual(['docs/a.md']);
  });

  it('replaces an existing credentials file and makes it private again', async () => {
    const a = makeRepo(tempDir('tabula-l2-'), cfg);
    const file = join(home, 'config.json');
    writeFile(home, 'config.json', JSON.stringify({ url: 'https://tabula.example.com', token: 'old' }));
    if (process.platform !== 'win32') chmodSync(file, 0o644);
    const ok = await runCli(['login', server.url, '--token-stdin'], { cwd: a, env: noCreds(), input: `${TEST_TOKEN}\n` });
    expect(ok.code, ok.stderr).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ url: server.url, token: TEST_TOKEN });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('shows the status, deletes on the server with rm (path relative to the current folder) and keeps the local file', async () => {
    const a = makeRepo(tempDir('tabula-r-'), cfg, { 'docs/a.md': 'a', 'docs/b.md': 'b', 'docs/plány/a b.md': 'ab' });
    expect((await runCli(['push'], { cwd: a, env: env() })).code).toBe(0);
    writeFile(a, 'docs/b.md', 'b2');
    writeFile(a, 'docs/c.md', 'c');
    const st = await runCli(['status'], { cwd: a, env: env() });
    expect(st.code).toBe(0);
    expect(st.stdout).toMatch(/changed locally\s+docs\/b\.md/);
    expect(st.stdout).toMatch(/new\s+docs\/c\.md/);
    const rm = await runCli(['rm', 'a.md'], { cwd: join(a, 'docs'), env: env() });
    expect(rm.code, rm.stderr).toBe(0);
    expect(await serverPaths()).toEqual(['docs/b.md', 'docs/plány/a b.md']);
    // A space and a diacritic must survive the query encoding of DELETE.
    const rmSpaced = await runCli(['rm', 'plány/a b.md'], { cwd: join(a, 'docs'), env: env() });
    expect(rmSpaced.code, rmSpaced.stderr).toBe(0);
    expect(await serverPaths()).toEqual(['docs/b.md']);
    expect(existsSync(join(a, 'docs', 'a.md'))).toBe(true);
    expect((await runCli(['status'], { cwd: a, env: env() })).stdout).toMatch(/deleted on server\s+docs\/a\.md/);
    expect((await runCli(['rm', 'docs/nope.md'], { cwd: a, env: env() })).code).toBe(1);
  });

  it('fails with exit 1 outside a repository, without .tabula.json, without credentials or with an unknown option', async () => {
    const plain = tempDir('tabula-p-');
    const outside = await runCli(['push'], { cwd: plain, env: { ...env(), GIT_CEILING_DIRECTORIES: dirname(plain) } });
    expect(outside.code).toBe(1);
    expect(outside.stderr).toMatch(/not inside a git repository/);
    const bare = tempDir('tabula-n-');
    git(bare, 'init', '-q');
    const noConfig = await runCli(['status'], { cwd: bare, env: env() });
    expect(noConfig.code).toBe(1);
    expect(noConfig.stderr).toMatch(/no \.tabula\.json/);
    const a = makeRepo(tempDir('tabula-x-'), cfg);
    const anonymous = await runCli(['status'], { cwd: a, env: noCreds() });
    expect(anonymous.code).toBe(1);
    expect(anonymous.stderr).toMatch(/tabula login/);
    expect((await runCli(['push', '--forse'], { cwd: a, env: env() })).code).toBe(1);
  });
});

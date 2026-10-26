#!/usr/bin/env node
// tabula: keeps a repository's untracked files (handoff state, private specs and plans) in a Tabula server.
// One dependency-free ES module for Node >= 22; the Tabula server serves it at GET /cli/tabula.mjs.
// Exit codes: 0 OK, 1 error, 2 finished with conflicts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.0.0';
/** 1 MiB, the server's limit for one file. */
export const MAX_BYTES = 1048576;
export const DEFAULT_STATE = ['docs/handoff/*.md', '**/docs/handoff/*.md'];

// ------------------------------------------------------------------ pure helpers (unit-tested)

/** Glob over POSIX paths: "**" spans directories (as a whole segment), "*" stays within one segment, "?" is one character. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      const segmentStart = i === 0 || glob[i - 1] === '/';
      if (glob[i + 1] === '*' && segmentStart && (i + 2 === glob.length || glob[i + 2] === '/')) {
        if (i + 2 === glob.length) re += '.*'; // trailing "**": everything below
        else {
          re += '(?:.*/)?'; // "**/": zero or more directories
          i++;
        }
        i++;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const compiled = new Map();
export function matchesAny(path, patterns) {
  return patterns.some((p) => {
    let re = compiled.get(p);
    if (!re) compiled.set(p, (re = globToRegExp(p)));
    return re.test(path);
  });
}

/** .env and .env.* in any folder are never uploaded, whatever the patterns say. */
export function isEnvFile(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name === '.env' || name.startsWith('.env.');
}

const BLOCKED_SEGMENTS = new Set(['', '.', '..', '.git', 'node_modules']);

/**
 * A relative POSIX path that stays inside the repository and outside .git and node_modules.
 * Segments are compared the way the server does (src/domain/files.ts): case-insensitive and without trailing
 * dots and spaces, because on Windows and macOS ".GIT", ".git." and ".git " resolve into the real .git. Windows
 * 8.3 short names ("GIT~1") and NTFS stream syntax (".git::$INDEX_ALLOCATION", any ":") can reach it as well.
 */
export function isSafeRelPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes(String.fromCharCode(0))) return false;
  if (path.startsWith('/') || path.includes(':')) return false;
  return !path.split('/').some((segment) => {
    const s = segment.toLowerCase().replace(/[. ]+$/, '');
    return BLOCKED_SEGMENTS.has(s) || /^git~\d+$/.test(s);
  });
}

/**
 * Where one path stands. local = hash of the file on disk, base = hash this clone last synced,
 * server = hash on the server (null = missing or deleted there).
 */
export function classify({ local, base, server }) {
  if (local === null) return server === null ? 'gone' : 'missing-locally';
  if (server === null) {
    if (base === null) return 'new';
    return local === base ? 'deleted-on-server' : 'changed';
  }
  if (local === server) return 'in-sync';
  if (base === server) return 'changed';
  if (base === local) return 'newer-on-server';
  return 'conflict';
}

/** Only UTF-8 text up to 1 MiB without NUL bytes is synced. */
export function checkText(bytes) {
  if (bytes.length > MAX_BYTES) return { ok: false, reason: `larger than 1 MiB (${bytes.length} bytes)` };
  if (bytes.includes(0)) return { ok: false, reason: 'binary (contains NUL bytes)' };
  try {
    // ignoreBOM keeps a byte-order mark in the text, so the server hashes exactly the bytes of the file.
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: 'not valid UTF-8' };
  }
}

export function parseArgs(argv) {
  const flags = new Set();
  const args = [];
  for (const a of argv) {
    if (a.startsWith('--')) flags.add(a);
    else args.push(a);
  }
  return { cmd: args.shift(), args, flags };
}

// ------------------------------------------------------------------ configuration and repository

export const tabulaHome = () => process.env.TABULA_HOME || join(homedir(), '.tabula');

/** Server URL and token; the environment wins over ~/.tabula/config.json. Missing values are ''. */
function readConnection() {
  const file = join(tabulaHome(), 'config.json');
  let saved = {};
  if (existsSync(file)) {
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new CliError(`${file} is not valid JSON; run tabula login <url> again`);
    }
  }
  return {
    url: String(process.env.TABULA_URL || saved.url || '').replace(/\/+$/, ''),
    token: String(process.env.TABULA_TOKEN || saved.token || ''),
  };
}

function requireConnection(conn) {
  if (!conn.url || !conn.token) throw new CliError('not logged in: run tabula login <url> (or set TABULA_URL and TABULA_TOKEN)');
  return conn;
}

/** In hook mode git calls share the hook's deadline. */
const gitTimeout = (repo) => (repo.deadline ? Math.max(1, repo.deadline - Date.now()) : 60000);

function git(cwd, args, timeout) {
  const r = spawnSync('git', args, { cwd, timeout, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new CliError(`git ${args[0]}: ${r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message}`);
  if (r.status !== 0) throw new CliError(`git ${args.join(' ')}: ${r.stderr.toString('utf8').trim()}`);
  return r.stdout.toString('utf8');
}

const nulList = (s) => s.split(String.fromCharCode(0)).filter(Boolean);

/** The repository around the current folder and its .tabula.json; null outside a git repository. */
function loadRepo(timeout) {
  const args = ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'];
  const r = spawnSync('git', args, { timeout, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  const [top, gitDir, common] = r.stdout.toString('utf8').trim().split(/\r?\n/);
  const root = realpathSync(top);
  // --git-common-dir may be relative to the current folder; in a linked worktree it is the main repository's .git.
  const commonDir = resolve(common);
  const file = join(root, '.tabula.json');
  if (!existsSync(file)) return { root, gitDir, commonDir, config: null };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new CliError(`.tabula.json is not valid JSON: ${e.message}`);
  }
  const list = (key) => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((p) => typeof p === 'string' && p)) {
      throw new CliError(`.tabula.json: "${key}" must be a list of glob patterns`);
    }
    return v;
  };
  const sync = list('sync');
  if (!sync?.length) throw new CliError('.tabula.json needs a non-empty "sync" list of glob patterns');
  const project = raw.project ?? basename(root).toLowerCase();
  if (typeof project !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(project)) {
    throw new CliError(`"${project}" is not a Tabula project slug; set "project" in .tabula.json`);
  }
  return { root, gitDir, commonDir, config: { project, sync, state: list('state') ?? DEFAULT_STATE } };
}

function openRepo() {
  const repo = loadRepo(60000);
  if (!repo) throw new CliError('not inside a git repository');
  if (!repo.config) throw new CliError(`no .tabula.json in ${repo.root}; the project's Setup tab in Tabula suggests one`);
  return repo;
}

/** Base hashes of this clone (per worktree), kept in the git directory so they are never committed. */
function loadSyncState(repo) {
  const file = join(repo.gitDir, 'tabula-sync.json');
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (s.project === repo.config.project && s.files && typeof s.files === 'object') return { file, files: s.files };
  } catch {
    // first run, or unreadable: start without bases
  }
  return { file, files: {} };
}

function saveSyncState(repo, state) {
  writeFileSync(state.file, `${JSON.stringify({ version: 1, project: repo.config.project, files: state.files }, null, 2)}\n`);
}

function readLocal(root, path) {
  try {
    return readFileSync(join(root, ...path.split('/')));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

/** fs.realpathSync.native, compared case-insensitively on Windows; it also expands 8.3 short names such as GIT~1. */
function realKey(p) {
  const real = realpathSync.native(p);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

const isWithin = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * The lexical check cannot see links, junctions or short names: resolve the deepest folder that already exists and
 * require it to be inside the repository and outside its git directories.
 */
function checkRealLocation(repo, dir, path) {
  let existing = dir;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = realKey(existing);
  if (!isWithin(real, realKey(repo.root))) throw new CliError(`refusing to write outside the repository: ${path}`);
  for (const gitDir of [repo.gitDir, repo.commonDir ?? repo.gitDir]) {
    if (isWithin(real, realKey(gitDir))) throw new CliError(`refusing to write inside the git directory: ${path}`);
  }
}

/** Write through a temporary file in the git directory and rename, so an interrupted pull never leaves half a file. */
function writeAtomic(repo, path, bytes) {
  if (!isSafeRelPath(path) || !withinPathLimits(path)) throw new CliError(`refusing to write the unsafe path ${path}`);
  const root = resolve(repo.root);
  const abs = resolve(root, ...path.split('/'));
  if (!abs.startsWith(root + sep)) throw new CliError(`refusing to write outside the repository: ${path}`);
  checkRealLocation(repo, dirname(abs), path);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(repo.gitDir, `tabula-pull-${process.pid}.tmp`);
  writeFileSync(tmp, bytes);
  try {
    renameSync(tmp, abs);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    writeFileSync(abs, bytes);
    rmSync(tmp, { force: true });
  }
}

// ------------------------------------------------------------------ server

/** fetch with the token and a timeout; network failures become a CliError. In hook mode every call ends by the deadline. */
function makeApi(conn, deadline) {
  return async (method, path, body) => {
    const ms = deadline ? Math.max(1, deadline - Date.now()) : 60000;
    try {
      const res = await fetch(conn.url + path, {
        method,
        headers: {
          authorization: `Bearer ${conn.token}`,
          'x-tabula-agent': 'cli',
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 401) throw new CliError('Tabula rejected the token; run tabula login <url> again');
      return { status: res.status, data };
    } catch (e) {
      if (e instanceof CliError) throw e;
      const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out' : (e.cause?.code ?? e.message);
      throw new CliError(`cannot reach ${conn.url}: ${why}`);
    }
  };
}

function ok(r, what) {
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new CliError(`${what}: HTTP ${r.status}${r.data?.message ? ` — ${r.data.message}` : ''}`);
}

const projectPath = (repo) => `/api/projects/${encodeURIComponent(repo.config.project)}`;

async function serverFiles(api, repo) {
  const r = await api('GET', `${projectPath(repo)}/files`);
  if (r.status === 404) {
    throw new CliError(`Tabula has no project "${repo.config.project}"; create it in the UI or ask the agent to run setup_project`);
  }
  return ok(r, 'listing files');
}

// ------------------------------------------------------------------ sync

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The server's other path rules (src/domain/files.ts): no control characters and at most 512 characters. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const MAX_PATH_CHARS = 512;
const withinPathLimits = (path) => !CONTROL_CHARS.test(path) && [...path].length <= MAX_PATH_CHARS;

/**
 * Every path this run cares about, classified: local candidates (untracked files matching "sync", only when
 * `candidates` is set) and the server's files (skipped when git tracks them here).
 */
function scan(repo, state, server, { candidates }) {
  const issues = [];
  const entries = new Map();
  const unmatched = [];
  if (candidates) {
    const untracked = new Set([
      ...nulList(git(repo.root, ['ls-files', '-z', '--others', '--exclude-standard'], gitTimeout(repo))),
      ...nulList(git(repo.root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], gitTimeout(repo))),
    ]);
    for (const path of untracked) {
      if (!matchesAny(path, repo.config.sync)) continue;
      // Warnings, not failures: one odd file name must not make every push exit 1.
      if (path.includes(':')) {
        issues.push({ path, reason: "path not accepted by Tabula (contains ':')" });
        continue;
      }
      if (!isSafeRelPath(path)) continue;
      if (!withinPathLimits(path)) {
        issues.push({ path, reason: `path not accepted by Tabula (control characters or over ${MAX_PATH_CHARS} characters)` });
        continue;
      }
      if (isEnvFile(path)) {
        issues.push({ path, reason: '.env files are never synced' });
        continue;
      }
      const bytes = readLocal(repo.root, path);
      if (!bytes) continue;
      const check = checkText(bytes);
      if (!check.ok) {
        issues.push({ path, reason: check.reason });
        continue;
      }
      entries.set(path, { path, candidate: true, local: sha256(bytes), text: check.text });
    }
  }
  const tracked = new Set(nulList(git(repo.root, ['ls-files', '-z', '--cached'], gitTimeout(repo))));
  for (const f of server) {
    if (entries.has(f.path)) continue;
    // Checked before anything touches the disk: pull writes only paths that pass the same rules as push.
    if (!isSafeRelPath(f.path) || !withinPathLimits(f.path) || isEnvFile(f.path)) {
      issues.push({ path: f.path, reason: 'unsafe path on the server, ignored' });
      continue;
    }
    // Only what this clone's .tabula.json asks for: a token holder must not plant .envrc, .vscode/tasks.json, hooks…
    if (!matchesAny(f.path, repo.config.sync)) {
      unmatched.push(f.path);
      continue;
    }
    if (tracked.has(f.path)) {
      issues.push({ path: f.path, reason: 'tracked by git here; the server copy is ignored' });
      continue;
    }
    const bytes = readLocal(repo.root, f.path);
    entries.set(f.path, { path: f.path, candidate: false, local: bytes ? sha256(bytes) : null });
  }
  const onServer = new Map(server.map((f) => [f.path, f.sha256]));
  const list = [...entries.values()].map((e) => {
    const base = state.files[e.path] ?? null;
    const remote = onServer.get(e.path) ?? null;
    return { ...e, base, server: remote, status: classify({ local: e.local, base, server: remote }) };
  });
  list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries: list, issues, unmatched };
}

const LABELS = {
  new: 'new',
  changed: 'changed locally',
  'newer-on-server': 'newer on server',
  conflict: 'conflict',
  'missing-locally': 'missing locally',
  'deleted-on-server': 'deleted on server',
};

async function status(repo, api, conn) {
  const state = loadSyncState(repo);
  const server = await serverFiles(api, repo);
  const { entries, issues, unmatched } = scan(repo, state, server, { candidates: true });
  out(`Tabula project ${repo.config.project} at ${conn.url}`);
  const shown = entries.filter((e) => LABELS[e.status]);
  for (const e of shown) out(`  ${LABELS[e.status].padEnd(18)}${e.path}`);
  for (const i of issues) out(`  ${'skipped'.padEnd(18)}${i.path} (${i.reason})`);
  for (const p of unmatched) out(`  ${'not matched'.padEnd(18)}${p} (on server, not matched by sync)`);
  if (!shown.length && !issues.length) out(`  everything in sync (${entries.length} files)`);
  return entries.some((e) => e.status === 'conflict') ? 2 : 0;
}

async function push(repo, api, { force }) {
  const state = loadSyncState(repo);
  const server = await serverFiles(api, repo);
  const { entries, issues } = scan(repo, state, server, { candidates: true });
  for (const i of issues) err(`skip ${i.path}: ${i.reason}`);
  const onServer = new Set(server.map((f) => f.path));
  let pushed = 0;
  let conflicts = 0;
  let failed = 0;
  let behind = 0;
  for (const e of entries) {
    if (!e.candidate) continue;
    if (e.status === 'in-sync') {
      state.files[e.path] = e.local;
      continue;
    }
    if (e.status === 'newer-on-server') {
      behind++;
      continue;
    }
    const overwrite = force && e.status === 'conflict';
    if (e.status === 'conflict' && !overwrite) {
      conflicts++;
      err(`conflict ${e.path}: changed here and on the server — run tabula pull, merge by hand, then tabula push (or tabula push --force to keep yours)`);
      continue;
    }
    if (e.status !== 'new' && e.status !== 'changed' && !overwrite) continue;
    const r = await api('PUT', `${projectPath(repo)}/files`, { path: e.path, content: e.text, base_sha256: e.base, force: overwrite });
    if (r.status === 409) {
      conflicts++;
      err(`conflict ${e.path}: changed on the server meanwhile — run tabula pull first`);
      continue;
    }
    if (r.status !== 200) {
      failed++;
      err(`failed ${e.path}: HTTP ${r.status}${r.data?.message ? ` — ${r.data.message}` : ''}`);
      continue;
    }
    if (r.data.sha256 !== e.local) err(`warning ${e.path}: the server stored a different hash`);
    state.files[e.path] = r.data.sha256;
    onServer.add(e.path);
    pushed++;
    out(`pushed ${e.path}`);
  }
  // The server never reads .tabula.json: the CLI tells it which files form the project state.
  const statePaths = [...onServer].filter((p) => matchesAny(p, repo.config.state));
  ok(await api('PUT', `${projectPath(repo)}/files/state`, { paths: statePaths }), 'marking state files');
  saveSyncState(repo, state);
  out(`tabula push ${repo.config.project}: ${pushed} pushed, ${conflicts} conflicts, ${issues.length} skipped${behind ? `, ${behind} newer on the server (run tabula pull)` : ''}`);
  return failed ? 1 : conflicts ? 2 : 0;
}

async function pull(repo, api, { force, hook }) {
  const state = loadSyncState(repo);
  const server = await serverFiles(api, repo);
  const { entries, issues } = scan(repo, state, server, { candidates: false });
  if (!hook) for (const i of issues) err(`skip ${i.path}: ${i.reason}`);
  let pulled = 0;
  let conflicts = 0;
  for (const e of entries) {
    if (e.server === null) continue;
    if (e.status === 'in-sync') {
      state.files[e.path] = e.server;
      continue;
    }
    const take = e.status === 'missing-locally' || e.status === 'newer-on-server' || (force && e.status === 'conflict');
    if (!take) {
      if (e.status === 'conflict') {
        conflicts++;
        if (!hook) err(`conflict ${e.path}: changed here and on the server — merge by hand, or tabula pull --force to take the server copy`);
      }
      continue;
    }
    const f = ok(await api('GET', `${projectPath(repo)}/files/content?path=${encodeURIComponent(e.path)}`), `reading ${e.path}`);
    const bytes = Buffer.from(f.content, 'utf8');
    try {
      writeAtomic(repo, e.path, bytes);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      if (!hook) err(`skip ${e.path}: ${error.message}`);
      continue;
    }
    state.files[e.path] = sha256(bytes);
    pulled++;
    if (!hook) out(`pulled ${e.path}`);
  }
  saveSyncState(repo, state);
  if (hook) {
    if (pulled || conflicts) {
      out(`tabula: restored ${pulled} file${pulled === 1 ? '' : 's'} from Tabula project ${repo.config.project}${conflicts ? `; ${conflicts} in conflict — run tabula status` : ''}`);
    }
  } else {
    out(`tabula pull ${repo.config.project}: ${pulled} pulled, ${conflicts} conflicts`);
  }
  return conflicts ? 2 : 0;
}

async function rm(repo, api, arg) {
  if (!arg) throw new CliError('usage: tabula rm <path>');
  const rel = relative(repo.root, resolve(realpathSync(process.cwd()), arg)).split(sep).join('/');
  if (!isSafeRelPath(rel)) throw new CliError(`${arg} is not a file inside the repository`);
  const r = await api('DELETE', `${projectPath(repo)}/files?path=${encodeURIComponent(rel)}`);
  if (r.status === 404) throw new CliError(`${rel} is not in Tabula project ${repo.config.project}`);
  ok(r, `deleting ${rel}`);
  out(`deleted ${rel} on the server (restore it in the Tabula UI); the local file is kept`);
  return 0;
}

// ------------------------------------------------------------------ login

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** Read a line from the terminal without echoing it. */
function promptHidden(question) {
  return new Promise((resolvePrompt, reject) => {
    const input = process.stdin;
    process.stderr.write(question);
    input.setRawMode(true);
    input.resume();
    let value = '';
    const finish = (error) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stderr.write('\n');
      if (error) reject(error);
      else resolvePrompt(value);
    };
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10) return finish();
        if (code === 3) return finish(new CliError('cancelled'));
        if (code === 127 || code === 8) value = value.slice(0, -1);
        else if (code >= 32) value += ch;
      }
    };
    input.on('data', onData);
  });
}

async function login(args, flags) {
  const url = (args[0] ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(url)) throw new CliError('usage: tabula login <url>, e.g. tabula login https://tabula.example.com');
  const fromStdin = flags.has('--token-stdin') || !process.stdin.isTTY;
  const token = (fromStdin ? await readStdin() : await promptHidden('Tabula token: ')).trim();
  if (!token) throw new CliError('no token given');
  ok(await makeApi({ url, token })('GET', '/api/projects'), 'checking the token');
  const home = tabulaHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'config.json');
  // A fresh file created with 0600 and renamed over the old one: the token is never readable by others, not even
  // for a moment when an older config.json had wider permissions (writeFileSync's mode applies only to new files).
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  // Windows ignores the mode; the user profile folder is private already.
  writeFileSync(tmp, `${JSON.stringify({ url, token }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
  out(`Logged in to ${url}. Saved ${file}`);
  return 0;
}

// ------------------------------------------------------------------ hook, install, update

/** The hook stops working at this point so a session start never waits 5 s (Node start-up included). */
const HOOK_DEADLINE_MS = 3500;

/** SessionStart mode: never fails the session and never holds it up for long. */
async function runHook() {
  const deadline = Date.now() + HOOK_DEADLINE_MS;
  // Last resort if something blocks past the deadline (a slow git, a stuck socket).
  setTimeout(() => {
    process.stderr.write('tabula: pull timed out; the session starts without it\n');
    process.exit(0);
  }, HOOK_DEADLINE_MS + 900).unref();
  try {
    const conn = readConnection();
    if (!conn.url || !conn.token) return 0;
    const repo = loadRepo(Math.max(1, deadline - Date.now()));
    if (!repo?.config) return 0;
    repo.deadline = deadline;
    await pull(repo, makeApi(conn, deadline), { force: false, hook: true });
  } catch (e) {
    process.stderr.write(`tabula: ${String(e?.message ?? e).split('\n')[0]}\n`);
  }
  return 0;
}

function install() {
  const home = tabulaHome();
  const target = join(home, 'tabula.mjs');
  const bin = join(home, 'bin');
  const self = realpathSync(fileURLToPath(import.meta.url));
  mkdirSync(bin, { recursive: true });
  if (!existsSync(target) || realpathSync(target) !== self) copyFileSync(self, target);
  const posix = target.split(sep).join('/');
  const sh = join(bin, 'tabula');
  writeFileSync(sh, `#!/bin/sh\nexec node "${posix}" "$@"\n`);
  try {
    chmodSync(sh, 0o755);
  } catch {
    // Windows has no execute bit; Git Bash runs the script by its shebang.
  }
  writeFileSync(join(bin, 'tabula.cmd'), `@echo off\r\nnode "${target}" %*\r\n`);
  out(`Installed ${target}`);
  out(`The commands tabula (sh) and tabula.cmd are in ${bin}. Add that folder to PATH once:`);
  out(
    process.platform === 'win32'
      ? `  PowerShell: [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${bin}', 'User')`
      : `  echo 'export PATH="${bin}:$PATH"' >> ~/.profile`,
  );
  out('Then log in: tabula login <url>');
  out('SessionStart hook for ~/.claude/settings.json (merge it into the hooks you already have):');
  const hook = { type: 'command', command: `node "${posix}" pull --hook`, timeout: 10 };
  out(JSON.stringify({ hooks: { SessionStart: [{ hooks: [hook] }] } }, null, 2));
  return 0;
}

async function update(conn) {
  if (!conn.url) throw new CliError('no server URL: run tabula login <url> first');
  let source;
  try {
    const res = await fetch(`${conn.url}/cli/tabula.mjs`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new CliError(`download failed: HTTP ${res.status}`);
    source = await res.text();
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`cannot reach ${conn.url}: ${e.cause?.code ?? e.message}`);
  }
  const m = /^export const VERSION = '([^']+)';\r?$/m.exec(source);
  if (!m) throw new CliError(`${conn.url}/cli/tabula.mjs is not the Tabula CLI`);
  const self = realpathSync(fileURLToPath(import.meta.url));
  writeFileSync(`${self}.tmp`, source);
  renameSync(`${self}.tmp`, self);
  out(m[1] === VERSION ? `tabula ${VERSION} is current; reinstalled it` : `updated tabula ${VERSION} → ${m[1]}`);
  return 0;
}

/** The server's CLI version when it differs from this one; null when equal or unknown. Never throws. */
async function newerVersion(url) {
  try {
    const r = await fetch(`${url}/cli/version`, { signal: AbortSignal.timeout(3000) });
    const { version } = await r.json();
    return typeof version === 'string' && version !== VERSION ? version : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ command line

export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

const HELP = `tabula ${VERSION} — keeps a repository's untracked files (handoff state, private specs and plans) in Tabula

Usage:
  tabula login <url> [--token-stdin]   save the server URL and token in ~/.tabula/config.json
  tabula status                        show what push and pull would do
  tabula push [--force]                upload new and changed files; never deletes
  tabula pull [--force]                download missing and newer files; never deletes local files
  tabula pull --hook                   SessionStart mode: quiet, at most 5 s, always exit 0
  tabula rm <path>                     delete a file on the server (restorable in the Tabula UI)
  tabula install                       put tabula on PATH (~/.tabula/bin) and print the SessionStart hook
  tabula update                        replace this file with the version the server offers

.tabula.json in the repository root: { "project"?: slug, "sync": [globs], "state"?: [globs] }
Environment: TABULA_URL and TABULA_TOKEN override the saved login; TABULA_HOME (default ~/.tabula).
Exit codes: 0 OK, 1 error, 2 finished with conflicts.`;

function fail(e) {
  if (e instanceof CliError) {
    err(`tabula: ${e.message}`);
    return e.code;
  }
  err(`tabula: unexpected error: ${e?.stack ?? e}`);
  return 1;
}

/** Options each command accepts (pull --hook is handled before this check). */
const FLAGS = {
  help: [], version: [], login: ['--token-stdin'], status: [], push: ['--force'], pull: ['--force'], rm: [], install: [], update: [],
};

export async function main(argv) {
  const { cmd, args, flags } = parseArgs(argv);
  if (cmd === 'pull' && flags.has('--hook')) return runHook();
  try {
    if (!cmd) {
      out(flags.has('--version') ? VERSION : HELP);
      return 0;
    }
    if (!Object.hasOwn(FLAGS, cmd)) throw new CliError(`unknown command "${cmd}"; run tabula help`);
    const unknown = [...flags].find((f) => !FLAGS[cmd].includes(f));
    if (unknown) throw new CliError(`tabula ${cmd} does not take ${unknown}`);
    if (cmd === 'help') {
      out(HELP);
      return 0;
    }
    if (cmd === 'version') {
      out(VERSION);
      return 0;
    }
    if (cmd === 'login') return await login(args, flags);
    if (cmd === 'install') return install();
    if (cmd === 'update') return await update(readConnection());
    const conn = requireConnection(readConnection());
    const repo = openRepo();
    const api = makeApi(conn);
    const newer = newerVersion(conn.url); // runs while the command works
    const code =
      cmd === 'status' ? await status(repo, api, conn)
      : cmd === 'push' ? await push(repo, api, { force: flags.has('--force') })
      : cmd === 'pull' ? await pull(repo, api, { force: flags.has('--force'), hook: false })
      : await rm(repo, api, args[0]);
    const v = await newer;
    if (v) err(`tabula: the server offers tabula ${v} (you have ${VERSION}); run tabula update`);
    return code;
  } catch (e) {
    return fail(e);
  }
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    // Keep-alive sockets or a pending version check must not hold the process open.
    setTimeout(() => process.exit(code), 300).unref();
  });
}

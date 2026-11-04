#!/usr/bin/env node
// tabula: keeps a repository's untracked files (handoff state, private specs and plans) in a Tabula server.
// One dependency-free ES module for Node >= 22; the Tabula server serves it at GET /cli/tabula.mjs.
// The server also imports this file for its glob matcher (src/domain/glob.ts): importing it must stay free of side
// effects beyond defining functions and constants.
// Exit codes: 0 OK, 1 error, 2 finished with conflicts.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.2.0';
/** 1 MiB, the server's limit for one file. */
export const MAX_BYTES = 1048576;
export const DEFAULT_STATE = ['docs/handoff/*.md', '**/docs/handoff/*.md'];

// ------------------------------------------------------------------ pure helpers (unit-tested)

/** "**" never spans a line break, as in the regex translation this matcher replaced. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * One path segment against one pattern segment: "*" is any run of characters, "?" is one, the rest is literal.
 * Two pointers that go back only to the last "*": O(pattern × segment), never exponential.
 */
function segmentMatch(pattern, text) {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * Glob over POSIX paths: a "**" segment spans directories (zero or more in the middle, one or more at the end), "*"
 * stays within one segment, "?" is one character. Matched segment by segment with dynamic programming, so the time
 * is bounded by pattern length × path length whatever the pattern (the server matches paths that agents choose).
 */
export function globMatch(glob, path) {
  const pat = glob.split('/');
  const segs = path.split('/');
  const n = segs.length;
  const plain = segs.map((s) => !LINE_BREAK.test(s));
  // next[j]: pattern segments after the current one match path segments j..n-1.
  let next = new Uint8Array(n + 1);
  next[n] = 1;
  for (let i = pat.length - 1; i >= 0; i--) {
    const row = new Uint8Array(n + 1);
    if (pat[i] === '**' && i === pat.length - 1) {
      for (let j = n - 1; j >= 0; j--) row[j] = plain[j] && (j === n - 1 || row[j + 1]) ? 1 : 0;
    } else if (pat[i] === '**') {
      row[n] = next[n];
      for (let j = n - 1; j >= 0; j--) row[j] = next[j] || (plain[j] && row[j + 1]) ? 1 : 0;
    } else {
      for (let j = 0; j < n; j++) row[j] = next[j + 1] && segmentMatch(pat[i], segs[j]) ? 1 : 0;
    }
    next = row;
  }
  return next[0] === 1;
}

export function matchesAny(path, patterns) {
  return patterns.some((p) => globMatch(p, path));
}

/**
 * .env and .env.* in any folder are never uploaded, whatever the patterns say. Case-insensitive and without trailing
 * dots and spaces, like the server (".ENV" and ".env " are the same file on Windows); .envrc stays allowed.
 */
export function isEnvFile(path) {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase().replace(/[. ]+$/, '');
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

/** transcribe.py exits with this when the GPU setup is unusable: the job goes back to the queue and the worker stops. */
export const TRANSCRIBER_ENVIRONMENT_EXIT = 3;

/** "0:05", "2:41", "1:02:03" (the server and the UI write times the same way). */
export function formatClock(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Wait before reconnecting after the n-th failure in a row: 2 s, 4 s, 8 s … at most a minute. */
export const workerBackoffMs = (failures) => Math.min(60000, 2000 * 2 ** Math.max(0, failures - 1));

/** One line of at most `max` characters, for the log and the job's error. */
export function shortError(text, max = 300) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return 'no details';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** ffmpeg's complaint about a recording without a sound track (a screen recording without the microphone). */
export const isNoAudioError = (stderr) => /does not contain any stream|matches no streams/i.test(String(stderr));

/** What transcribe.py printed, as the server expects it: whole milliseconds, one-line texts, no empty ones, in time order. */
export function normalizeTranscript(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.segments)) throw new CliError('the transcriber printed no segments');
  const segments = [];
  for (const s of raw.segments) {
    const start = Math.max(0, Math.round(Number(s?.start_ms)));
    const end = Math.max(start, Math.round(Number(s?.end_ms)));
    const text = String(s?.text ?? '').replace(/\s+/g, ' ').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && text) segments.push({ start_ms: start, end_ms: end, text });
  }
  segments.sort((a, b) => a.start_ms - b.start_ms);
  const duration = Math.round(Number(raw.duration_ms));
  return {
    language: typeof raw.language === 'string' && raw.language ? raw.language : null,
    duration_ms: Number.isFinite(duration) && duration > 0 ? duration : null,
    segments,
  };
}

// ------------------------------------------------------------------ configuration and repository

export const tabulaHome = () => process.env.TABULA_HOME || join(homedir(), '.tabula');

const configFile = () => join(tabulaHome(), 'config.json');

/** ~/.tabula/config.json as an object; {} when it does not exist. */
function readConfigFile() {
  const file = configFile();
  if (!existsSync(file)) return {};
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new CliError(`${file} is not valid JSON; run tabula login <url> again`);
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/**
 * Replace config.json. It holds tokens: a fresh file created with 0600 and renamed over the old one is never readable
 * by others, not even for a moment when an older config.json had wider permissions (writeFileSync's mode applies only
 * to new files). Windows ignores the mode; the user profile folder is private already.
 */
function writeConfigFile(data) {
  mkdirSync(tabulaHome(), { recursive: true, mode: 0o700 });
  const file = configFile();
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
  return file;
}

/** Server URL and token; the environment wins over ~/.tabula/config.json. Missing values are ''. */
function readConnection() {
  const saved = readConfigFile();
  return {
    url: String(process.env.TABULA_URL || saved.url || '').replace(/\/+$/, ''),
    token: String(process.env.TABULA_TOKEN || saved.token || ''),
  };
}

/**
 * Where the worker keeps its Python environment and log: %LOCALAPPDATA%\tabula on Windows, $XDG_DATA_HOME/tabula
 * (~/.local/share/tabula) elsewhere. TABULA_DATA_DIR overrides it.
 */
export function dataHome(env = process.env, platform = process.platform, home = homedir()) {
  if (env.TABULA_DATA_DIR) return env.TABULA_DATA_DIR;
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'tabula');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'tabula');
}

/** The Python inside a virtual environment. */
export const venvPython = (venv, platform = process.platform) =>
  platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');

/** A program from the worker settings: a path, or a list ["program", "first argument", …] (e.g. a script run by node). */
export function commandLine(value, what) {
  if (typeof value === 'string' && value) return [value];
  if (Array.isArray(value) && value.length && value.every((v) => typeof v === 'string' && v)) return [...value];
  throw new CliError(`worker.${what} in ${configFile()} must be a program path or a list of strings`);
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
  if (!isWithin(real, realKey(repo.root))) throw refusal(`refusing to write outside the repository: ${path}`);
  for (const gitDir of [repo.gitDir, repo.commonDir ?? repo.gitDir]) {
    if (isWithin(real, realKey(gitDir))) throw refusal(`refusing to write inside the git directory: ${path}`);
  }
}

/** A file-system error as one readable line; `abs` is the file that was being written. */
function describeFsError(e, abs) {
  let folder = false;
  try {
    folder = statSync(abs).isDirectory();
  } catch {
    // nothing there
  }
  if (folder) return 'a folder of that name is in the way';
  const why = {
    ENOTDIR: 'a file is in the way of one of its folders',
    EEXIST: 'a file is in the way of one of its folders',
    EPERM: 'the file is locked or read-only (open in another program?)',
    EBUSY: 'the file is locked by another program',
    EACCES: 'permission denied',
    ENOSPC: 'the disk is full',
  }[e?.code];
  return why ? `${why} (${e.code})` : String(e?.message ?? e);
}

/** A path this clone will not write on purpose (unsafe, outside the repository): pull skips it, it is no failure. */
const refusal = (message) => Object.assign(new CliError(message), { refusal: true });

/**
 * Write through a temporary file in the git directory and rename, so an interrupted pull never leaves half a file.
 * Every failure is a CliError, and the temporary file never outlives the call.
 */
function writeAtomic(repo, path, bytes) {
  if (!isSafeRelPath(path) || !withinPathLimits(path)) throw refusal(`refusing to write the unsafe path ${path}`);
  const root = resolve(repo.root);
  const abs = resolve(root, ...path.split('/'));
  if (!abs.startsWith(root + sep)) throw refusal(`refusing to write outside the repository: ${path}`);
  const tmp = join(repo.gitDir, `tabula-pull-${process.pid}.tmp`);
  try {
    checkRealLocation(repo, dirname(abs), path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(tmp, bytes);
    try {
      renameSync(tmp, abs);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      writeFileSync(abs, bytes);
    }
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(describeFsError(e, abs));
  } finally {
    try {
      rmSync(tmp, { force: true }); // already gone after a successful rename
    } catch {
      // a locked temporary file is the next run's to replace; never hide the real outcome behind it
    }
  }
}

export const WORKER_DEFAULTS = Object.freeze({
  model: 'large-v3', language: 'sk', device: 'cuda', compute_type: 'float16', beam_size: 5, initial_prompt: '', ffmpeg: 'ffmpeg',
});

/**
 * The worker's settings: the "worker" section of config.json over the defaults. TABULA_URL and TABULA_WORKER_TOKEN
 * win; the URL falls back to the one of tabula login. The worker never uses the main token.
 */
function readWorkerConfig() {
  const saved = readConfigFile();
  const w = saved.worker && typeof saved.worker === 'object' && !Array.isArray(saved.worker) ? saved.worker : {};
  const merged = { ...WORKER_DEFAULTS, ...w };
  return {
    ...merged,
    url: String(process.env.TABULA_URL || w.url || saved.url || '').replace(/\/+$/, ''),
    token: String(process.env.TABULA_WORKER_TOKEN || w.token || ''),
    python: merged.python ?? '',
    script: String(merged.script || join(dataHome(), 'whisper', 'transcribe.py')),
    beam_size: Number.isInteger(merged.beam_size) && merged.beam_size > 0 ? merged.beam_size : WORKER_DEFAULTS.beam_size,
  };
}

// ------------------------------------------------------------------ server

/**
 * fetch with the token and a timeout; network failures become a CliError. In hook mode every call ends by the deadline.
 * Errors are tagged for the pull loop: `unreachable` (no answer; `timedOut` when the timeout fired) and `rejected` (401).
 */
export function makeApi(conn, deadline) {
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
      if (res.status === 401) {
        throw Object.assign(new CliError('Tabula rejected the token; run tabula login <url> again'), { rejected: true });
      }
      return { status: res.status, data };
    } catch (e) {
      if (e instanceof CliError) throw e;
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      const why = timedOut ? 'timed out' : (e.cause?.code ?? e.message);
      throw Object.assign(new CliError(`cannot reach ${conn.url}: ${why}`), { unreachable: true, timedOut });
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

const foldCase = (path) => path.toLowerCase();

/**
 * The spelling on disk when `path` exists here only in another letter case (a file or one of its folders), else null.
 * `listings` caches one directory listing per folder for the whole scan.
 */
function caseTwinOnDisk(root, path, listings) {
  const parts = path.split('/');
  let dir = root;
  for (let i = 0; i < parts.length; i++) {
    let listing = listings.get(dir);
    if (!listing) {
      listing = { exact: new Set(), folded: new Map() };
      try {
        for (const n of readdirSync(dir)) {
          listing.exact.add(n);
          listing.folded.set(foldCase(n), n);
        }
      } catch {
        // the folder does not exist (yet)
      }
      listings.set(dir, listing);
    }
    if (!listing.exact.has(parts[i])) {
      const twin = listing.folded.get(foldCase(parts[i]));
      return twin === undefined ? null : [...parts.slice(0, i), twin, ...parts.slice(i + 1)].join('/');
    }
    dir = join(dir, parts[i]);
  }
  return null;
}

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
  const tracked = new Map(
    nulList(git(repo.root, ['ls-files', '-z', '--cached'], gitTimeout(repo))).map((p) => [foldCase(p), p]),
  );
  const fromServer = [];
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
    const trackedAs = tracked.get(foldCase(f.path));
    if (trackedAs !== undefined) {
      const reason = trackedAs === f.path ? 'tracked by git here' : `differs only in letter case from the tracked ${trackedAs}`;
      issues.push({ path: f.path, reason: `${reason}; the server copy is ignored` });
      continue;
    }
    fromServer.push(f.path);
  }
  // Paths that differ only in letter case are one file on Windows and macOS: sync neither, so one never overwrites the
  // other. Pairs among the server's and this clone's candidates, then server paths against what is on disk.
  const twins = new Map();
  const byFold = new Map();
  for (const p of [...entries.keys(), ...fromServer]) {
    const other = byFold.get(foldCase(p));
    if (other === undefined) byFold.set(foldCase(p), p);
    else {
      if (!twins.has(other)) twins.set(other, p);
      twins.set(p, other);
    }
  }
  const listings = new Map();
  for (const p of fromServer) {
    if (twins.has(p)) continue;
    const onDisk = caseTwinOnDisk(repo.root, p, listings);
    if (onDisk) twins.set(p, onDisk);
  }
  for (const [path, other] of twins) {
    issues.push({ path, reason: `differs only in letter case from ${other}; neither is synced, so one never overwrites the other` });
    entries.delete(path);
  }
  for (const path of fromServer) {
    if (twins.has(path)) continue;
    const bytes = readLocal(repo.root, path);
    entries.set(path, { path, candidate: false, local: bytes ? sha256(bytes) : null });
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

/** More new files than this in one push get a warning first. */
const LARGE_PUSH = 100;

async function push(repo, api, { force }) {
  const state = loadSyncState(repo);
  const server = await serverFiles(api, repo);
  const { entries, issues } = scan(repo, state, server, { candidates: true });
  for (const i of issues) err(`skip ${i.path}: ${i.reason}`);
  // A broad "sync" pattern can sweep in far more than intended; say so before it lands on the server.
  const fresh = entries.filter((e) => e.candidate && e.status === 'new').length;
  if (fresh > LARGE_PUSH) {
    err(`warning: about to upload ${fresh} new files to Tabula project ${repo.config.project}; if that is more than intended, narrow "sync" in .tabula.json (tabula status lists them) and remove the extra ones with tabula rm`);
  }
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
  await sendSyncConfig(api, repo);
  out(`tabula push ${repo.config.project}: ${pushed} pushed, ${conflicts} conflicts, ${issues.length} skipped${behind ? `, ${behind} newer on the server (run tabula pull)` : ''}`);
  return failed ? 1 : conflicts ? 2 : 0;
}

/**
 * The server keeps the patterns so agents without this command (write_file over MCP) write only synced paths.
 * Never fails the push: an older server without the endpoint answers 404.
 */
async function sendSyncConfig(api, repo) {
  let why;
  try {
    const r = await api('PUT', `${projectPath(repo)}/sync-config`, { sync: repo.config.sync, state: repo.config.state });
    if (r.status >= 200 && r.status < 300) return;
    why = `HTTP ${r.status}${r.status === 404 ? ' — the server is older than this command' : r.data?.message ? ` — ${r.data.message}` : ''}`;
  } catch (e) {
    why = String(e?.message ?? e);
  }
  err(`warning: Tabula did not store the sync patterns of .tabula.json (${why}); agents without the tabula command cannot write files of this project until it does`);
}

/**
 * What one failed download or write means for the pull loop: 'deadline' (the hook ran out of time: stop and keep what
 * came), 'stop' (server gone or token rejected: the other files would fail the same way), 'skip' (a path this clone
 * refuses to write) or 'failed'. In hook mode every timeout is the deadline's: AbortSignal.timeout runs on another
 * clock than Date.now() and can fire a millisecond before `now >= deadline` holds.
 */
export function pullFailure(error, { hook, deadline, now = Date.now() }) {
  if (hook && (error?.timedOut || now >= deadline)) return 'deadline';
  if (error?.unreachable || error?.rejected) return 'stop';
  return error?.refusal ? 'skip' : 'failed';
}

/**
 * Downloads missing and newer files, state files first. One file that cannot be fetched or written is reported and
 * skipped; the rest still come. In hook mode the loop stops at the deadline and keeps what it restored.
 */
async function pull(repo, api, { force, hook }) {
  const state = loadSyncState(repo);
  const server = await serverFiles(api, repo);
  const { entries, issues } = scan(repo, state, server, { candidates: false });
  if (!hook) for (const i of issues) err(`skip ${i.path}: ${i.reason}`);
  const flaggedState = new Set(server.filter((f) => f.isState).map((f) => f.path));
  const isState = (e) => flaggedState.has(e.path) || matchesAny(e.path, repo.config.state);
  const todo = [];
  let conflicts = 0;
  for (const e of entries) {
    if (e.server === null) continue;
    if (e.status === 'in-sync') {
      state.files[e.path] = e.server;
      continue;
    }
    if (e.status === 'missing-locally' || e.status === 'newer-on-server' || (force && e.status === 'conflict')) {
      todo.push(e);
      continue;
    }
    if (e.status === 'conflict') {
      conflicts++;
      if (!hook) err(`conflict ${e.path}: changed here and on the server — merge by hand, or tabula pull --force to take the server copy`);
    }
  }
  // State first: when the hook runs out of time, the handoff state is what the session needs most. The sort is stable,
  // so the rest stays in path order.
  todo.sort((a, b) => Number(isState(b)) - Number(isState(a)));
  let pulled = 0;
  let failed = 0;
  let timedOut = false;
  for (const [index, e] of todo.entries()) {
    if (hook && Date.now() >= repo.deadline) {
      timedOut = true;
      break;
    }
    try {
      const f = ok(await api('GET', `${projectPath(repo)}/files/content?path=${encodeURIComponent(e.path)}`), `reading ${e.path}`);
      const bytes = Buffer.from(f.content, 'utf8');
      writeAtomic(repo, e.path, bytes);
      state.files[e.path] = sha256(bytes);
      pulled++;
      if (!hook) out(`pulled ${e.path}`);
    } catch (error) {
      const kind = pullFailure(error, { hook, deadline: repo.deadline });
      if (kind === 'deadline') {
        timedOut = true; // the download was cut off by the deadline, not a failure of this file
        break;
      }
      const message = String(error?.message ?? error).split('\n')[0];
      if (kind === 'stop') {
        // Server gone or token rejected: every other file would fail the same way, after the same wait.
        const left = todo.length - index;
        failed += left;
        if (!hook) err(`failed ${e.path}: ${message}; stopped, ${left} file${left === 1 ? '' : 's'} not pulled`);
        break;
      }
      if (kind === 'skip') {
        if (!hook) err(`skip ${e.path}: ${message}`);
      } else {
        failed++;
        if (!hook) err(`failed ${e.path}: ${message}`);
      }
    }
  }
  saveSyncState(repo, state);
  if (hook) {
    const from = `from Tabula project ${repo.config.project}`;
    const restored = timedOut
      ? `restored ${pulled} of ${todo.length} files ${from}; run tabula pull for the rest`
      : `restored ${pulled} file${pulled === 1 ? '' : 's'} ${from}`;
    const notes = [
      ...(failed ? [`${failed} could not be restored — run tabula pull`] : []),
      ...(conflicts ? [`${conflicts} in conflict — run tabula status`] : []),
    ];
    if (pulled || timedOut || notes.length) out(`tabula: ${[restored, ...notes].join('; ')}`);
  } else {
    out(`tabula pull ${repo.config.project}: ${pulled} pulled, ${conflicts} conflicts${failed ? `, ${failed} failed` : ''}`);
  }
  return failed ? 1 : conflicts ? 2 : 0;
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
  // Without a terminal and without the flag, a silent wait for input would look like a hang.
  if (!flags.has('--token-stdin') && !process.stdin.isTTY) err('Reading the token from stdin (end with Ctrl+D)');
  const token = (fromStdin ? await readStdin() : await promptHidden('Tabula token: ')).trim();
  if (!token) throw new CliError('no token given');
  ok(await makeApi({ url, token })('GET', '/api/projects'), 'checking the token');
  let saved = {};
  try {
    saved = readConfigFile();
  } catch {
    // a config.json that is not valid JSON is replaced
  }
  // Other sections (the transcription worker's settings) stay as they are.
  const file = writeConfigFile({ ...saved, url, token });
  out(`Logged in to ${url}. Saved ${file}`);
  return 0;
}

// ------------------------------------------------------------------ hook, install, update

/**
 * The hook stops working at this point so a session start never waits 5 s (Node start-up included).
 * TABULA_HOOK_DEADLINE_MS exists for the tests and can only shorten it.
 */
const HOOK_DEADLINE_MS = Math.min(3500, Number(process.env.TABULA_HOOK_DEADLINE_MS) || 3500);

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
      : `  echo 'export PATH="${bin}:$PATH"' >> ~/.profile\n  (zsh does not read ~/.profile: append the same line to ~/.zprofile or ~/.zshrc instead)`,
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
  await refreshTranscriber(conn.url);
  return 0;
}

/** After an update: a transcribe.py that tabula worker setup put in the data folder is replaced with the server's. */
async function refreshTranscriber(url) {
  let script;
  try {
    script = resolve(readWorkerConfig().script);
  } catch {
    return; // no usable configuration: nothing to refresh
  }
  if (!existsSync(script) || !isWithin(script, resolve(dataHome()))) return;
  try {
    await fetchTranscriber(url, script, { preferLocal: false });
    out(`updated ${script}`);
  } catch (e) {
    err(`warning: ${script} was not updated: ${e.message}`);
  }
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

// ------------------------------------------------------------------ transcription worker

/** How often a running job's lease is extended. TABULA_WORKER_HEARTBEAT_MS exists for the tests and can only shorten it. */
const HEARTBEAT_MS = Math.min(60000, Number(process.env.TABULA_WORKER_HEARTBEAT_MS) || 60000);
/** The server holds a claim open this long when the queue is empty. */
const CLAIM_WAIT_S = 30;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** How long after ffmpeg or the transcriber failed a Ctrl+C still makes it a release instead of a failure (see runJob). */
const STOP_GRACE_MS = 1000;

/** The host name as an HTTP header value (ASCII only); the server lower-cases and checks it. */
const workerId = () => hostname().replace(/[^\x21-\x7e]/g, '').slice(0, 63) || 'worker';

/**
 * Child programs get the user's environment without Tabula's tokens. PYTHONUTF8: Python's stderr reaches the worker as
 * UTF-8 on Windows too, not in the console's code page.
 */
function childEnv() {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^TABULA_/i.test(k))), PYTHONUTF8: '1' };
}

/**
 * End a child and everything it started. On Windows a venv's python.exe (and the py launcher) only starts the real
 * interpreter as its own child: killing the direct child would leave that one running, holding the GPU's memory and
 * the output pipes (so `close` would never come). taskkill /T ends the whole tree.
 */
function killTree(child) {
  if (process.platform !== 'win32' || !child.pid) return void child.kill();
  const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  tk.on('error', () => child.kill());
  tk.on('close', (code) => {
    if (code !== 0) child.kill();
  });
}

/** A program that could not be started at all (missing, not executable, a .cmd without a shell): a broken setup. */
function cannotStart(cmd, e) {
  const missing = e?.code === 'ENOENT';
  return Object.assign(new Error(missing ? `${cmd} was not found` : `${cmd} could not be started: ${e?.code ?? e?.message ?? e}`), {
    missing, cannotStart: true,
  });
}

const sleep = (ms, signal) =>
  new Promise((resolveSleep) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolveSleep();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * Run a program without a shell, so paths with spaces need no quoting. Resolves { code, stdout, stderr } (stderr's
 * last 8 KB); kills it (with what it started) when `signal` aborts or after `timeoutMs`. A program that cannot be
 * started rejects with `cannotStart: true` (and `missing: true` when it does not exist); a stop with `aborted: true`.
 */
function runProcess(command, args, { input, signal, timeoutMs = 600000 } = {}) {
  const [cmd, ...pre] = command;
  return new Promise((resolveRun, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('stopped'), { aborted: true }));
    let child;
    try {
      child = spawn(cmd, [...pre, ...args], { env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(cannotStart(cmd, e)); // e.g. EINVAL for a .cmd or .bat file, which needs a shell
      return;
    }
    const stdout = [];
    let stderr = '';
    let timedOut = false;
    const kill = () => killTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
    };
    child.stdout.on('data', (d) => stdout.push(d));
    child.stderr.setEncoding('utf8').on('data', (d) => {
      stderr = (stderr + d).slice(-8192);
    });
    child.stdin.on('error', () => {}); // a program that does not read its input closes the pipe early
    child.on('error', (e) => {
      settle();
      reject(cannotStart(cmd, e));
    });
    child.on('close', (code) => {
      settle();
      if (signal?.aborted) return reject(Object.assign(new Error('stopped'), { aborted: true }));
      if (timedOut) return reject(new Error(`${basename(cmd)} did not finish within ${Math.round(timeoutMs / 60000)} min`));
      resolveRun({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr });
    });
    child.stdin.end(input ?? '');
  });
}

/**
 * A call to /api/worker/* with the worker token. No answer → Error with `unreachable`; 401 → CliError with `rejected`;
 * a server without the worker API enabled → CliError.
 */
async function workerFetch(cfg, method, path, body, { timeoutMs = 60000, signal } = {}) {
  // `signal` cancels only the wait for the answer: once the headers are in, the body is read to the end, so a claimed
  // job reaches runJob (which releases it) instead of being dropped until its lease runs out.
  const waiting = new AbortController();
  const cancel = () => waiting.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  let res;
  try {
    res = await fetch(cfg.url + path, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'x-tabula-worker': workerId(),
        'x-tabula-version': VERSION,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), waiting.signal]),
    });
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error('stopped'), { aborted: true });
    const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out' : (e.cause?.code ?? e.message);
    throw Object.assign(new Error(`cannot reach ${cfg.url}: ${why}`), { unreachable: true });
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401) {
    throw Object.assign(new CliError('Tabula rejected the worker token; run tabula worker setup again (it needs TABULA_WORKER_TOKEN, not TABULA_TOKEN)'), { rejected: true });
  }
  if (res.status === 503 && /TABULA_WORKER_TOKEN/.test(data?.message ?? '')) {
    throw new CliError(`${cfg.url} has no transcription worker enabled: set TABULA_WORKER_TOKEN on the server and restart it`);
  }
  return { status: res.status, data };
}

/** The next job, or null when the queue stayed empty for `waitS` seconds. */
async function claimNext(cfg, waitS, signal) {
  const r = await workerFetch(cfg, 'POST', '/api/worker/jobs/claim', { wait: waitS }, { timeoutMs: (waitS + 30) * 1000, signal });
  if (r.status === 204) return null;
  if (r.status === 200 && r.data?.id) return r.data;
  throw Object.assign(new Error(`claim: HTTP ${r.status}${r.data?.message ? ` — ${r.data.message}` : ''}`), { unreachable: r.status >= 500 });
}

/** Stream the recording to `file` through its signed link (no token). 404/410 mean it is gone for good. */
async function download(cfg, mediaPath, file, signal) {
  let res;
  try {
    res = await fetch(cfg.url + mediaPath, { signal: AbortSignal.any([signal, AbortSignal.timeout(3600000)]) });
  } catch (e) {
    if (signal.aborted) throw Object.assign(new Error('stopped'), { aborted: true });
    throw new Error(`download failed: ${e.cause?.code ?? e.message}`);
  }
  if (res.status === 410) throw Object.assign(new Error('the recording was deleted on the server'), { permanent: true });
  if (res.status === 404) throw Object.assign(new Error('the recording is missing on the server'), { permanent: true });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file), { signal });
}

/**
 * ffmpeg or the transcriber ended with an error by itself (the worker did not kill it). Tagged `exited`: a Ctrl+C in
 * the terminal reaches these programs too (the whole console on Windows, the process group elsewhere), and one may
 * exit before the worker sees the signal (see runJob).
 */
const exitError = (message, more) => Object.assign(new Error(message), { exited: true, ...more });

const environmentError = (message) => Object.assign(new Error(message), { environment: true });

/** 16 kHz mono WAV for Whisper; false when the recording has no sound track. */
async function extractAudio(cfg, input, wav, signal) {
  let r;
  try {
    r = await runProcess(
      commandLine(cfg.ffmpeg, 'ffmpeg'),
      ['-nostdin', '-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav],
      { signal, timeoutMs: 1800000 },
    );
  } catch (e) {
    if (e.missing) throw environmentError('ffmpeg was not found: install it and open a new terminal, or set worker.ffmpeg in config.json');
    if (e.cannotStart || e instanceof CliError) throw environmentError(`${e.message}; check worker.ffmpeg in config.json`);
    throw e;
  }
  if (r.code === 0) return true;
  if (isNoAudioError(r.stderr)) return false;
  throw exitError(`ffmpeg could not read the recording: ${shortError(r.stderr)}`);
}

/** One Python process per recording: the model leaves the GPU's memory when the process ends. */
async function transcribe(cfg, wav, signal) {
  if (!cfg.python || (Array.isArray(cfg.python) && !cfg.python.length)) throw environmentError('no Python environment for transcription: run tabula worker setup');
  if (!existsSync(cfg.script)) throw environmentError(`transcribe.py is missing at ${cfg.script}: run tabula worker setup`);
  const options = {
    wav,
    model: cfg.model,
    language: cfg.language && cfg.language !== 'auto' ? cfg.language : null,
    device: cfg.device,
    compute_type: cfg.compute_type,
    initial_prompt: cfg.initial_prompt || null,
    beam_size: cfg.beam_size,
  };
  let r;
  try {
    r = await runProcess(commandLine(cfg.python, 'python'), [cfg.script], { input: JSON.stringify(options), signal, timeoutMs: 4 * 3600000 });
  } catch (e) {
    if (e.cannotStart || e instanceof CliError) throw environmentError(`${e.message}: run tabula worker setup`);
    throw e;
  }
  if (r.code === TRANSCRIBER_ENVIRONMENT_EXIT) throw exitError(shortError(r.stderr), { environment: true });
  if (r.code !== 0) throw exitError(`transcription failed (exit ${r.code}): ${shortError(r.stderr)}`);
  try {
    return normalizeTranscript(JSON.parse(r.stdout));
  } catch (e) {
    throw exitError(e instanceof SyntaxError ? 'the transcriber did not print JSON' : e.message);
  }
}

/** Log lines with the local time; with --log they go to worker.log in the data folder instead of the console. */
function makeLog(toFile) {
  const file = join(dataHome(), 'worker.log');
  if (toFile) mkdirSync(dirname(file), { recursive: true });
  const p = (n) => String(n).padStart(2, '0');
  return (line) => {
    const d = new Date();
    const text = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${line}\n`;
    if (!toFile) return void process.stdout.write(text);
    try {
      if (existsSync(file) && statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, text);
    } catch {
      process.stdout.write(text); // a locked log file must not stop the worker
    }
  };
}

/** One job, start to end. Returns 'done', 'failed' (reported), 'lost' (the server took it back), 'released' or 'environment'. */
export async function runJob(cfg, job, { log, stop }) {
  const tag = `job ${job.id.slice(0, 8)}`;
  const a = job.attachment;
  const started = Date.now();
  log(`${tag}: ${a.kind} ${a.duration_ms ? formatClock(a.duration_ms) : '(length unknown)'}, ${(a.size / 1048576).toFixed(1)} MB, project ${job.report.project}, "${job.report.title.slice(0, 60)}", attempt ${job.attempt}`);
  const work = new AbortController();
  const onStop = () => work.abort();
  stop.addEventListener('abort', onStop);
  if (stop.aborted) work.abort(); // stopped while the claim's answer was read: give the job straight back
  let lost = false;
  const beat = setInterval(() => {
    workerFetch(cfg, 'POST', `/api/worker/jobs/${job.id}/heartbeat`, { lease: job.lease }, { timeoutMs: 30000 })
      .then((r) => {
        if (r.status === 409 || r.status === 404) {
          lost = true;
          work.abort();
        }
      })
      .catch(() => {}); // the lease lasts 10 minutes; a later heartbeat may get through
  }, HEARTBEAT_MS);
  const report = (path, body) => workerFetch(cfg, 'POST', `/api/worker/jobs/${job.id}/${path}`, { lease: job.lease, ...body }, { timeoutMs: 60000 });
  let dir;
  try {
    try {
      dir = mkdtempSync(join(tmpdir(), 'tabula-worker-'));
    } catch (e) {
      throw environmentError(`cannot create a temporary folder in ${tmpdir()}: ${e.code ?? e.message}`);
    }
    const input = join(dir, 'recording');
    await download(cfg, job.media_path, input, work.signal);
    const wav = join(dir, 'audio.wav');
    const hasAudio = await extractAudio(cfg, input, wav, work.signal);
    const result = hasAudio ? await transcribe(cfg, wav, work.signal) : { language: null, duration_ms: null, segments: [] };
    // The transcript is the expensive part: a short network outage must not lose it.
    let r;
    for (let attempt = 1; ; attempt++) {
      try {
        r = await report('complete', { model: cfg.model, ...result });
        break;
      } catch (e) {
        if (!e.unreachable || attempt >= 5) throw e;
        log(`${tag}: ${shortError(e.message)}; sending the transcript again in ${workerBackoffMs(attempt) / 1000} s`);
        await sleep(workerBackoffMs(attempt));
      }
    }
    if (r.status === 409 || r.status === 404) {
      log(`${tag}: the server no longer expects this job (${shortError(r.data?.message ?? r.status)}); result dropped`);
      return 'lost';
    }
    if (r.status !== 200) throw new Error(`the server refused the transcript: HTTP ${r.status}${r.data?.message ? ` — ${r.data.message}` : ''}`);
    const took = ((Date.now() - started) / 1000).toFixed(1);
    const audio = result.duration_ms ? ` from ${formatClock(result.duration_ms)} of audio` : '';
    log(`${tag}: done in ${took} s, ${result.segments.length} segments${audio}${hasAudio ? '' : ' (no sound track)'}`);
    return 'done';
  } catch (e) {
    // While stopping, whatever ffmpeg or the transcriber exited with gives the attempt back. A terminal Ctrl+C reaches
    // them as well and one may exit first: a stop that follows the exit within STOP_GRACE_MS still counts.
    if (e.exited && !stop.aborted) await sleep(STOP_GRACE_MS, stop);
    if (lost) {
      log(`${tag}: the server gave the job to another worker or cancelled it; stopped working on it`);
      return 'lost';
    }
    if (stop.aborted || e.environment) {
      await report('release', {}).catch(() => {});
      if (stop.aborted) {
        log(`${tag}: stopped; the job went back to the queue`);
        return 'released';
      }
      log(`${tag}: ${shortError(e.message)}`);
      log('the job went back to the queue; check the setup with tabula worker doctor, then start the worker again');
      return 'environment';
    }
    const message = shortError(e.message);
    const r = await report('fail', { error: message, permanent: e.permanent === true }).catch(() => null);
    log(`${tag}: failed: ${message}${r?.data?.status === 'queued' ? ' (the server will offer it again later)' : ''}`);
    return 'failed';
  } finally {
    clearInterval(beat);
    stop.removeEventListener('abort', onStop);
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch {
      // a file still held by a killed process; the system cleans its temp folder
    }
  }
}

/** tabula worker [--once] [--log] */
async function workerRun(flags) {
  const toFile = flags.has('--log');
  const log = makeLog(toFile);
  try {
    return await workerLoop(flags.has('--once'), log);
  } catch (e) {
    // With --log nobody sees the console (Task Scheduler): why the worker stopped belongs in worker.log too.
    if (toFile) log(e instanceof CliError ? e.message : `unexpected error: ${shortError(e?.message ?? e)}`);
    throw e;
  }
}

async function workerLoop(once, log) {
  const cfg = readWorkerConfig();
  if (!cfg.url) throw new CliError('no server URL: run tabula worker setup <url> (or tabula login <url> first)');
  if (!cfg.token) throw new CliError('no worker token: run tabula worker setup');
  // A broken program setting stops the worker before it takes a job, instead of failing every job in the queue.
  commandLine(cfg.ffmpeg, 'ffmpeg');
  if (!cfg.python) throw new CliError('no Python environment for transcription: run tabula worker setup');
  commandLine(cfg.python, 'python');
  const stop = new AbortController();
  const onSignal = () => {
    if (stop.signal.aborted) process.exit(130); // a second Ctrl+C: leave at once
    log('stopping… (Ctrl+C again to quit at once)');
    stop.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  log(`tabula worker ${VERSION} ${once ? 'transcribing what is queued' : 'waiting for jobs (Ctrl+C stops)'}; server ${cfg.url}`);
  const counts = { done: 0, failed: 0 };
  let failures = 0;
  try {
    while (!stop.signal.aborted) {
      let job;
      try {
        job = await claimNext(cfg, once ? 0 : CLAIM_WAIT_S, stop.signal);
        if (failures) log('connected again');
        failures = 0;
      } catch (e) {
        if (e instanceof CliError) throw e;
        if (e.aborted || stop.signal.aborted) break;
        if (once) throw new CliError(shortError(e.message));
        failures++;
        const wait = workerBackoffMs(failures);
        log(`${shortError(e.message)}; trying again in ${wait / 1000} s`);
        await sleep(wait, stop.signal);
        continue;
      }
      if (!job) {
        if (once) break;
        continue;
      }
      const outcome = await runJob(cfg, job, { log, stop: stop.signal });
      if (outcome === 'environment') return 1;
      if (outcome === 'done') counts.done++;
      if (outcome === 'failed') counts.failed++;
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  log(`worker stopped: ${counts.done} transcribed, ${counts.failed} failed`);
  return 0;
}

/**
 * The worker's Python packages, within the versions verified together: faster-whisper, CTranslate2, and CUDA 12's
 * cuBLAS and cuDNN as wheels (no CUDA toolkit needed).
 */
export const WHISPER_PACKAGES = ['faster-whisper>=1.2.1,<2', 'ctranslate2>=4.8.4,<5', 'nvidia-cublas-cu12>=12.9,<13', 'nvidia-cudnn-cu12>=9,<10'];

/** Python 3.9+ to create the environment with: the py launcher first on Windows, python3 elsewhere. */
function findPython() {
  const candidates = process.platform === 'win32' ? [['py', '-3'], ['python']] : [['python3'], ['python']];
  for (const c of candidates) {
    const r = spawnSync(c[0], [...c.slice(1), '-c', 'import sys; print(sys.version.split()[0])'], {
      encoding: 'utf8', windowsHide: true, timeout: 30000, env: childEnv(),
    });
    const version = r.status === 0 ? r.stdout.trim() : '';
    const [major, minor] = version.split('.').map(Number);
    if (major === 3 && minor >= 9) return { command: c, version };
  }
  const tried = candidates.map((c) => c.join(' ')).join(', ');
  throw new CliError(`Python 3.9 or newer was not found (tried ${tried}); install it from python.org (on Windows with the "py" launcher) and run tabula worker setup again`);
}

/** Run a step of the setup with its output on this console (pip shows its progress). */
function runVisible(command, args, what) {
  const r = spawnSync(command[0], [...command.slice(1), ...args], { stdio: 'inherit', windowsHide: true, env: childEnv() });
  if (r.error) throw new CliError(`${what}: ${r.error.message}`);
  if (r.status !== 0) throw new CliError(`${what} failed (exit ${r.status}); see the output above`);
}

/**
 * cli/transcribe.py into `dest`: copied from next to this file when it is there (a repository checkout) and
 * `preferLocal`, otherwise downloaded from the server.
 */
async function fetchTranscriber(url, dest, { preferLocal = true } = {}) {
  const sibling = join(dirname(realpathSync(fileURLToPath(import.meta.url))), 'transcribe.py');
  let source;
  if (preferLocal && existsSync(sibling)) source = readFileSync(sibling);
  else {
    let res;
    try {
      res = await fetch(`${url}/cli/transcribe.py`, { signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new CliError(`cannot reach ${url}: ${e.cause?.code ?? e.message}`);
    }
    if (!res.ok) throw new CliError(`downloading transcribe.py failed: HTTP ${res.status}`);
    source = Buffer.from(await res.arrayBuffer());
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(`${dest}.tmp`, source);
  renameSync(`${dest}.tmp`, dest);
}

/** tabula worker setup [<url>] [--token-stdin]: token first (nothing is installed with a wrong one), then Python. */
async function workerSetup(urlArg, flags) {
  const current = readWorkerConfig();
  const url = String(urlArg ?? current.url).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(url)) {
    throw new CliError('usage: tabula worker setup <url>, e.g. tabula worker setup https://tabula.example.com (or tabula login <url> first)');
  }
  let token = current.token;
  if (!token || flags.has('--token-stdin')) {
    const fromStdin = flags.has('--token-stdin') || !process.stdin.isTTY;
    token = (fromStdin ? await readStdin() : await promptHidden('Worker token (TABULA_WORKER_TOKEN of the server): ')).trim();
  }
  if (!token) throw new CliError('no worker token given');
  const check = await workerFetch({ url, token }, 'GET', '/api/worker/ping', undefined, { timeoutMs: 30000 });
  if (check.status !== 200) throw new CliError(`checking the worker token: HTTP ${check.status}${check.data?.message ? ` — ${check.data.message}` : ''}`);
  out(`The worker token works on ${url} (${check.data.queued} job(s) waiting).`);

  const whisper = join(dataHome(), 'whisper');
  const venv = join(whisper, 'venv');
  const python = venvPython(venv);
  if (!existsSync(python)) {
    const found = findPython();
    out(`Creating the Python environment in ${venv} with Python ${found.version}…`);
    mkdirSync(whisper, { recursive: true });
    runVisible(found.command, ['-m', 'venv', venv], 'creating the Python environment');
  }
  out(`Installing ${WHISPER_PACKAGES.join(', ')} (several hundred MB the first time)…`);
  runVisible([python], ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', ...WHISPER_PACKAGES], 'pip install');
  const script = join(whisper, 'transcribe.py');
  await fetchTranscriber(url, script);

  const saved = readConfigFile();
  const previous = saved.worker && typeof saved.worker === 'object' && !Array.isArray(saved.worker) ? saved.worker : {};
  const worker = { ...WORKER_DEFAULTS, ...previous, url, token, python, script };
  const file = writeConfigFile({ ...saved, worker });
  out(`Saved the worker settings in the "worker" section of ${file}:`);
  out(`  model ${worker.model}, language ${worker.language} ("auto" detects it), device ${worker.device}, compute_type ${worker.compute_type}`);
  out('  Put the names of your projects and technical words into initial_prompt, so Whisper spells them right.');
  out('Next: tabula worker doctor (checks ffmpeg, CUDA and the GPU, then transcribes a 5 s sample)');
  return 0;
}

/** tabula worker doctor: every link of the chain, with what to do about a broken one. Exit 1 when something fails. */
async function workerDoctor() {
  const cfg = readWorkerConfig();
  let problems = 0;
  const line = (state, text, hint) => {
    out(`${state.padEnd(4)}  ${text}`);
    if (hint && state !== 'ok') out(`      ${hint}`);
    if (state === 'FAIL') problems++;
  };

  if (!cfg.url || !cfg.token) line('FAIL', 'no server URL or worker token', 'run tabula worker setup <url>');
  else {
    try {
      const r = await workerFetch(cfg, 'GET', '/api/worker/ping', undefined, { timeoutMs: 15000 });
      if (r.status === 200) line('ok', `${cfg.url} accepts the worker token; ${r.data.queued} job(s) waiting`);
      else line('FAIL', `${cfg.url} answered HTTP ${r.status}`, r.data?.message);
    } catch (e) {
      line('FAIL', shortError(e.message), e.rejected ? 'run tabula worker setup again with the server\'s TABULA_WORKER_TOKEN' : 'check the URL and the network');
    }
  }

  const ffmpeg = commandLine(cfg.ffmpeg, 'ffmpeg');
  const ff = await runProcess(ffmpeg, ['-version'], { timeoutMs: 15000 }).catch(() => null);
  if (ff?.code === 0) line('ok', `ffmpeg: ${shortError(ff.stdout.split(/\r?\n/)[0], 80)}`);
  else {
    const hint = process.platform === 'win32' ? 'install it (winget install Gyan.FFmpeg) and open a new terminal, or set worker.ffmpeg in config.json' : 'install ffmpeg, or set worker.ffmpeg in config.json';
    line('FAIL', `ffmpeg (${ffmpeg.join(' ')}) does not run`, hint);
  }

  let gpuReady = false;
  if (!cfg.python) line('FAIL', 'no Python environment for transcription', 'run tabula worker setup');
  else if (!existsSync(cfg.script)) line('FAIL', `transcribe.py is missing at ${cfg.script}`, 'run tabula worker setup');
  else {
    const r = await runProcess(commandLine(cfg.python, 'python'), [cfg.script, '--check'], { timeoutMs: 120000 })
      .catch((e) => ({ code: -1, stdout: '', stderr: e.message }));
    let info = null;
    try {
      info = r.code === 0 ? JSON.parse(r.stdout) : null;
    } catch {
      // reported below
    }
    if (!info) line('FAIL', `the Python environment does not work: ${shortError(r.stderr)}`, 'run tabula worker setup again');
    else {
      line('ok', `Python ${info.python}, faster-whisper ${info.faster_whisper}, CTranslate2 ${info.ctranslate2}`);
      if (cfg.device !== 'cuda') line('warn', `device is "${cfg.device}", not cuda`, 'the worker is meant for an NVIDIA GPU; large-v3 on a CPU takes hours');
      if (!info.cuda_devices) {
        line('FAIL', `CTranslate2 sees no CUDA device${info.cuda_error ? `: ${shortError(info.cuda_error, 160)}` : ''}`, 'install or update the NVIDIA driver (RTX 50xx cards need one with CUDA 12.8 or newer)');
      } else if (!info.compute_types.includes(cfg.compute_type)) {
        line('FAIL', `the GPU does not support compute_type ${cfg.compute_type} (it supports ${info.compute_types.join(', ')})`, 'set worker.compute_type in config.json to one of them');
      } else {
        line('ok', `CUDA: ${info.cuda_devices} device(s), ${cfg.compute_type} supported`);
        gpuReady = true;
      }
    }
  }

  const smi = await runProcess(['nvidia-smi'], ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], { timeoutMs: 15000 }).catch(() => null);
  if (smi?.code === 0) line('ok', `GPU: ${shortError(smi.stdout, 160)}`);
  else line('warn', 'nvidia-smi does not run', 'it comes with the NVIDIA driver; without the driver CUDA cannot work');

  if (gpuReady && ff?.code === 0) {
    const dir = mkdtempSync(join(tmpdir(), 'tabula-doctor-'));
    try {
      const wav = join(dir, 'sample.wav');
      const made = await runProcess(
        ffmpeg,
        ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav],
        { timeoutMs: 60000 },
      );
      if (made.code !== 0) throw new Error(`ffmpeg could not make the sample: ${shortError(made.stderr)}`);
      out(`      transcribing a 5 s sample with ${cfg.model} (the first run downloads the model, about 3 GB)…`);
      const started = Date.now();
      await transcribe(cfg, wav, new AbortController().signal);
      line('ok', `test transcription with ${cfg.model} on ${cfg.device}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    } catch (e) {
      line('FAIL', `test transcription: ${shortError(e.message)}`, e.environment ? 'tabula worker setup reinstalls the packages' : undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else line('skip', 'test transcription (fix the problems above first)');

  out(problems ? `${problems} problem(s) found.` : 'Everything works: start the worker with tabula worker (or tabula worker --once).');
  return problems ? 1 : 0;
}

/** Options of each worker subcommand ("run" is plain tabula worker). */
const WORKER_FLAGS = { run: ['--once', '--log'], setup: ['--token-stdin'], doctor: [] };

async function workerCommand(args, flags) {
  const sub = args.length ? args[0] : 'run';
  if ((sub === 'run' && args.length) || !Object.hasOwn(WORKER_FLAGS, sub)) {
    throw new CliError(`unknown worker command "${args[0]}"; run tabula help`);
  }
  const unknown = [...flags].find((f) => !WORKER_FLAGS[sub].includes(f));
  if (unknown) throw new CliError(`tabula worker${sub === 'run' ? '' : ` ${sub}`} does not take ${unknown}`);
  if (sub === 'setup') return workerSetup(args[1], flags);
  if (sub === 'doctor') return workerDoctor();
  return workerRun(flags);
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
  tabula worker [--once] [--log]       transcribe bug-report recordings until Ctrl+C (--once: what is queued, then exit;
                                       --log: write to worker.log in the data folder instead of the console)
  tabula worker setup [<url>] [--token-stdin]
                                       create the Python environment for transcription and save the worker token
  tabula worker doctor                 check ffmpeg, Python, CUDA and the GPU, then transcribe a 5 s sample

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
  worker: ['--once', '--log', '--token-stdin'],
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
    if (cmd === 'worker') return await workerCommand(args, flags);
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

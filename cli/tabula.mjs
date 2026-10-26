#!/usr/bin/env node
// tabula: keeps a repository's untracked files (handoff state, private specs and plans) in a Tabula server.
// One dependency-free ES module for Node >= 22; the Tabula server serves it at GET /cli/tabula.mjs.
// Exit codes: 0 OK, 1 error, 2 finished with conflicts.
import { realpathSync } from 'node:fs';
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
 * dots and spaces, because on Windows and macOS ".GIT", ".git." and ".git " resolve into the real .git.
 */
export function isSafeRelPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes(String.fromCharCode(0))) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split('/').some((s) => BLOCKED_SEGMENTS.has(s.toLowerCase().replace(/[. ]+$/, '')));
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

export async function main(argv) {
  const { cmd, flags } = parseArgs(argv);
  try {
    if (!cmd) {
      out(flags.has('--version') ? VERSION : HELP);
      return 0;
    }
    if (cmd === 'help') {
      out(HELP);
      return 0;
    }
    if (cmd === 'version') {
      out(VERSION);
      return 0;
    }
    throw new CliError(`unknown command "${cmd}"; run tabula help`);
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

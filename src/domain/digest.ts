import { shortIds } from './ids.js';
import { DIGEST_BUDGET, estimateTokens } from './tokens.js';
import type { MemoryKind } from './validation.js';

/** An active memory of the global project: a global rule, gotcha, fact or decision. */
export type DigestMemory = { id: string; kind: MemoryKind; title: string; body: string; updatedAt: Date };
/** A synced file of the project, without its content. */
export type DigestFile = { path: string; size: number; updatedAt: Date; isState: boolean };
/** A state file with its content; pass them newest first. */
export type DigestStateFile = { path: string; content: string; updatedAt: Date };
export type DigestInput = {
  project: string;
  date: string;
  memories: DigestMemory[];
  files: DigestFile[];
  /** Omitted or empty when recall is called with include_state: false. */
  state?: DigestStateFile[];
  budget?: number;
};
export type TrimStep =
  | 'files-collapsed' | 'facts-omitted' | 'gotchas-first-sentence' | 'rules-first-sentence' | 'state-truncated';
export type Digest = { text: string; tokens: number; trimmed: TrimStep[]; overBudget: boolean };

/** Applied in this order while the global rules and the file list leave the state too little room. */
const REST_TRIM_ORDER: TrimStep[] = ['files-collapsed', 'facts-omitted', 'gotchas-first-sentence', 'rules-first-sentence'];
/** A state file keeps at least this many characters, or it is replaced by a pointer to read_file. */
const MIN_STATE_CHARS = 200;
const EMPTY = 'No global rules and no synced files yet. Files appear here after `tabula push` in a repository with a `.tabula.json`.';

export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = /^.*?[.!?](?=\s|$)/.exec(flat);
  return m ? m[0] : flat;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const newestFirst = <T extends { updatedAt: Date }>(items: T[]) =>
  [...items].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
const byPath = <T extends { path: string }>(items: T[]) =>
  [...items].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

function globalSections(memories: DigestMemory[], ids: Map<string, string>, has: (s: TrimStep) => boolean): string[] {
  const line = (m: DigestMemory) => `- ${m.title} (#${ids.get(m.id)})`;
  const indent = (s: string) => s.split('\n').map((l) => `  ${l}`).join('\n');
  const withBody = (m: DigestMemory, short: boolean) => `${line(m)}\n${indent(short ? firstSentence(m.body) : m.body.trim())}`;
  const of = (...kinds: MemoryKind[]) => newestFirst(memories.filter((m) => kinds.includes(m.kind)));
  const out: string[] = [];
  const add = (heading: string, lines: string[]) => {
    if (lines.length) out.push(`## ${heading}\n${lines.join('\n')}`);
  };
  add('Global rules (always follow)', of('rule').map((m) => withBody(m, has('rules-first-sentence'))));
  add('Global gotchas', of('gotcha').map((m) => withBody(m, has('gotchas-first-sentence'))));
  const facts = of('fact', 'decision');
  if (has('facts-omitted') && facts.length) out.push(`## Global facts and decisions\n- ${facts.length} omitted — use search`);
  else add('Global facts and decisions (title only — `get` for the why)', facts.map(line));
  return out;
}

function filesSection(files: DigestFile[], has: (s: TrimStep) => boolean): string[] {
  if (files.length === 0) return [];
  if (has('files-collapsed')) return [`## Files\n- ${files.length} synced files — call \`list_files\` for the list`];
  const lines = byPath(files).map((f) => `- ${f.path} — ${day(f.updatedAt)}, ${formatSize(f.size)}${f.isState ? ' (state)' : ''}`);
  return [`## Files (${files.length}) — \`read_file\` for the content\n${lines.join('\n')}`];
}

/** The state section in at most maxChars characters; files that do not fit are cut at a line break or replaced by a pointer. */
function stateSection(state: DigestStateFile[], maxChars: number): { text: string; truncated: boolean } {
  const head = '## Project state';
  const title = (f: DigestStateFile) => `### ${f.path} (${day(f.updatedAt)})`;
  const omitted = (f: DigestStateFile) => `${title(f)}\n[omitted to fit the budget — read_file("${f.path}")]`;
  const parts: string[] = [];
  let truncated = false;
  /** Characters used so far, including the separator before the next part. */
  const used = () => head.length + 1 + parts.join('\n\n').length + (parts.length ? 2 : 0);
  state.forEach((f, i) => {
    // Keep room for the pointers of the files after this one.
    const reserve = state.slice(i + 1).reduce((n, g) => n + 2 + omitted(g).length, 0);
    const body = f.content.trim() || '(empty)';
    const room = maxChars - used() - reserve - title(f).length - 1;
    if (body.length <= room) {
      parts.push(`${title(f)}\n${body}`);
      return;
    }
    truncated = true;
    const note = `[… truncated — read_file("${f.path}") for the rest]`;
    const keep = room - note.length - 1;
    if (keep < MIN_STATE_CHARS) {
      parts.push(omitted(f));
      return;
    }
    const cut = body.slice(0, keep);
    const nl = cut.lastIndexOf('\n');
    parts.push(`${title(f)}\n${(nl >= keep / 2 ? cut.slice(0, nl) : cut).trimEnd()}\n${note}`);
  });
  return { text: `${head}\n${parts.join('\n\n')}`, truncated };
}

export function buildDigest(input: DigestInput): Digest {
  const budget = input.budget ?? DIGEST_BUDGET;
  const maxChars = budget * 4;
  const ids = shortIds(input.memories.map((m) => m.id));
  const header = `# Tabula · ${input.project} · ${input.date}`;
  const applied: TrimStep[] = [];
  const has = (s: TrimStep) => applied.includes(s);
  const render = () => ({ rules: globalSections(input.memories, ids, has), files: filesSection(input.files, has) });
  let rest = render();
  const restChars = () => [header, ...rest.rules, ...rest.files].join('\n\n').length + 1;
  const pending = [...REST_TRIM_ORDER];
  const trimRest = () => {
    applied.push(pending.shift()!);
    rest = render();
  };
  const state = input.state ?? [];
  // Room kept for the state section and its separator: its full text, but at most half the budget.
  const stateReserve = state.length
    ? Math.min(stateSection(state, Number.POSITIVE_INFINITY).text.length + 2, Math.floor(maxChars / 2))
    : 0;
  const compose = () => {
    const s = state.length ? stateSection(state, maxChars - restChars() - 2) : undefined;
    const sections = [header, ...rest.rules, ...(s ? [s.text] : []), ...rest.files];
    if (sections.length === 1) sections.push(EMPTY);
    return { text: `${sections.join('\n\n')}\n`, stateTruncated: s?.truncated ?? false };
  };
  // The global rules and the file list are trimmed first, until they leave the state its reserve.
  while (pending.length && restChars() + stateReserve > maxChars) trimRest();
  let out = compose();
  // The state's headings and pointers may still not fit in what is left: keep trimming the rest.
  while (pending.length && out.text.length > maxChars) {
    trimRest();
    out = compose();
  }
  const trimmed: TrimStep[] = out.stateTruncated ? [...applied, 'state-truncated'] : applied;
  let text = out.text;
  const overBudget = estimateTokens(text) > budget;
  if (overBudget) {
    const [head, ...more] = text.split('\n\n');
    const withWarning = (n: number) =>
      [head, `(Over budget: ~${n} tokens of ${budget} after all trimming. Shorten the global rules in Tabula.)`, ...more].join('\n\n');
    // The count is part of the text it counts: settle on the number that includes the warning itself.
    let n = estimateTokens(text);
    while (estimateTokens(withWarning(n)) !== n) n = estimateTokens(withWarning(n));
    text = withWarning(n);
  }
  return { text, tokens: estimateTokens(text), trimmed, overBudget };
}

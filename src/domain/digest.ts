import { shortIds } from './ids.js';
import { DIGEST_BUDGET, estimateTokens, wordCount } from './tokens.js';
import type { MemoryKind } from './validation.js';

export type DigestMemory = { id: string; projectId: string; kind: MemoryKind; title: string; body: string; updatedAt: Date };
export type DigestNote = {
  id: string; projectId: string | null; title: string; summary: string; body: string; pinned: boolean; updatedAt: Date;
};
export type DigestInput = { project: string; date: string; memories: DigestMemory[]; notes: DigestNote[]; budget?: number };
export type TrimStep =
  | 'decisions-omitted' | 'rules-first-sentence' | 'gotchas-first-sentence' | 'facts-omitted' | 'notes-omitted';
export type Digest = { text: string; tokens: number; trimmed: TrimStep[]; overBudget: boolean };

/** The first two steps come from the spec; the rest is an extension from the plan (decision 6). Pinned notes are never trimmed. */
const TRIM_ORDER: TrimStep[] = [
  'decisions-omitted', 'rules-first-sentence', 'gotchas-first-sentence', 'facts-omitted', 'notes-omitted',
];

export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = /^.*?[.!?](?=\s|$)/.exec(flat);
  return m ? m[0] : flat;
}

function ordered<T extends { projectId: string | null; updatedAt: Date }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const scope = Number(a.projectId !== 'global') - Number(b.projectId !== 'global');
    return scope !== 0 ? scope : b.updatedAt.getTime() - a.updatedAt.getTime();
  });
}

function render(input: DigestInput, ids: Map<string, string>, trim: ReadonlySet<TrimStep>): string {
  const g = (x: { projectId: string | null }) => (x.projectId === 'global' && input.project !== 'global' ? '[g] ' : '');
  const ref = (id: string) => `#${ids.get(id)}`;
  const of = (kind: MemoryKind) => ordered(input.memories.filter((m) => m.kind === kind));
  const indent = (s: string) => s.split('\n').map((l) => `  ${l}`).join('\n');
  const line = (m: DigestMemory) => `- ${g(m)}${m.title} (${ref(m.id)})`;
  const withBody = (m: DigestMemory, short: boolean) =>
    `${line(m)}\n${indent(short ? firstSentence(m.body) : m.body.trim())}`;

  const sections: string[] = [];
  const add = (heading: string, lines: string[]) => {
    if (lines.length) sections.push(`## ${heading}\n${lines.join('\n')}`);
  };
  const omitted = (heading: string, n: number, what: string) => add(heading, [`- ${n} ${what} omitted — use search`]);

  add('Rules (always follow)', of('rule').map((m) => withBody(m, trim.has('rules-first-sentence'))));
  add('Gotchas', of('gotcha').map((m) => withBody(m, trim.has('gotchas-first-sentence'))));

  const decisions = of('decision');
  if (trim.has('decisions-omitted') && decisions.length) omitted('Decisions', decisions.length, 'decisions');
  else add('Decisions (title only — `get` for the why)', decisions.map(line));

  const facts = of('fact');
  if (trim.has('facts-omitted') && facts.length) omitted('Facts', facts.length, 'facts');
  else add('Facts', facts.map(line));

  const listed = ordered(input.notes.filter((n) => !n.pinned));
  if (trim.has('notes-omitted') && listed.length) omitted('Notes', listed.length, 'notes');
  else
    add(
      'Notes (human-authored, read-only — `get` for full text)',
      listed.map((n) => `- ${ref(n.id)} ${g(n)}${n.title}${n.summary ? ` — ${n.summary}` : ''} (${wordCount(n.body)} words)`),
    );

  for (const n of ordered(input.notes.filter((x) => x.pinned))) {
    sections.push(`## Pinned note: ${g(n)}${n.title} (${ref(n.id)})\n${n.body.trim()}`);
  }

  if (sections.length === 0) {
    sections.push('No active memories or notes yet. Call `remember` when you make a decision a future session must know.');
  }

  const header =
    input.project === 'global'
      ? `# Tabula · global · ${input.date}`
      : `# Tabula · ${input.project} (+ global) · ${input.date}`;
  return `${[header, ...sections].join('\n\n')}\n`;
}

export function buildDigest(input: DigestInput): Digest {
  const budget = input.budget ?? DIGEST_BUDGET;
  const ids = shortIds([...input.memories.map((m) => m.id), ...input.notes.map((n) => n.id)]);
  const applied = new Set<TrimStep>();
  let text = render(input, ids, applied);
  for (const step of TRIM_ORDER) {
    if (estimateTokens(text) <= budget) break;
    applied.add(step);
    text = render(input, ids, applied);
  }
  const overBudget = estimateTokens(text) > budget;
  if (overBudget) {
    const [head, ...rest] = text.split('\n\n');
    const warning = `(Over budget: ~${estimateTokens(text)} tokens of ${budget} after all trimming. Shorten pinned notes or condense rules and gotchas in Tabula.)`;
    text = [head, warning, ...rest].join('\n\n');
  }
  return { text, tokens: estimateTokens(text), trimmed: [...applied], overBudget };
}

import { badRequest } from './errors.js';

export const LIMITS = { title: 120, body: 2000, noteSummary: 200, thoughtTitle: 200, thoughtBody: 50_000 } as const;

/** The order is also the order of sections in the digest. */
export const MEMORY_KINDS = ['rule', 'gotcha', 'decision', 'fact'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const charCount = (s: string): number => [...s].length;

/** Postgres text columns reject NUL; better a 400 than a 500 from the DB. */
export function rejectNul(value: string, field: string): void {
  if (value.includes('\u0000')) throw badRequest(`${field} must not contain NUL characters`);
}

function requireTitle(raw: string): string {
  const title = raw.trim();
  if (!title) throw badRequest('title must not be empty');
  rejectNul(title, 'title');
  if (/[\r\n]/.test(title)) throw badRequest('title must be a single line');
  return title;
}

export function validateMemoryText(input: { title: string; body: string }): { title: string; body: string } {
  const title = requireTitle(input.title);
  const t = charCount(title);
  if (t > LIMITS.title) {
    throw badRequest(`title is ${t} characters; the limit is ${LIMITS.title}. Shorten it and move detail into body.`);
  }
  const body = input.body.trim();
  if (!body) throw badRequest('body must not be empty: explain the why and the context in 1-5 sentences');
  rejectNul(body, 'body');
  const b = charCount(body);
  if (b > LIMITS.body) throw badRequest(`body is ${b} characters; the limit is ${LIMITS.body}.`);
  return { title, body };
}

export function validateNoteText(input: { title: string; summary: string }): { title: string; summary: string } {
  const title = requireTitle(input.title);
  const summary = input.summary.trim();
  rejectNul(summary, 'summary');
  const s = charCount(summary);
  if (s > LIMITS.noteSummary) throw badRequest(`summary is ${s} characters; the limit is ${LIMITS.noteSummary}.`);
  return { title, summary };
}

export function validateThoughtText(input: { title: string; body: string }): { title: string; body: string } {
  const title = requireTitle(input.title);
  const t = charCount(title);
  if (t > LIMITS.thoughtTitle) throw badRequest(`title is ${t} characters; the limit is ${LIMITS.thoughtTitle}.`);
  const body = input.body.trim();
  rejectNul(body, 'body');
  const b = charCount(body);
  if (b > LIMITS.thoughtBody) {
    throw badRequest(`body is ${b} characters; the limit is ${LIMITS.thoughtBody}. Split it into several thoughts.`);
  }
  return { title, body };
}

export function normalizeTags(tags?: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of tags ?? []) {
    const v = t.trim().toLowerCase();
    if (v) out.add(v);
  }
  return [...out];
}

const LABEL = /^[a-z0-9._-]{1,40}$/;

export function sanitizeAgentLabel(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  const v = raw.trim().toLowerCase();
  return LABEL.test(v) ? v : 'unknown';
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function validateProjectSlug(id: string): string {
  const v = id.trim();
  if (!SLUG.test(v)) throw badRequest(`project slug "${id}" is invalid: use lowercase letters, digits and dashes (max 40)`);
  return v;
}

import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { type Diarization, reportAttachments, reports, reportTranscripts, type SpeakerNames, type TranscriptSegment } from '../db/schema.js';
import { badRequest, notFound } from './errors.js';
import { charCount } from './validation.js';

/** "S1" … "S99", as the worker numbers the speakers. */
export const SPEAKER_ID = /^S[0-9]{1,2}$/;
export const SPEAKER_NAME_MAX = 60;
export const SUGGESTIONS_MAX = 20;
export const DIARIZATION_ERROR_MAX = 2000;
const MODEL_NAME = /^[\x20-\x7e]{1,200}$/;

/** "  Eva \n Novák " → "Eva Novák"; '' for a blank name. Control characters and names over 60 characters are a 400. */
export function cleanSpeakerName(raw: string, speaker: string): string {
  if (typeof raw !== 'string') throw badRequest(`the name of ${speaker} must be a string`);
  const name = raw.replace(/\s+/g, ' ').trim();
  if (/\p{Cc}/u.test(name)) throw badRequest(`the name of ${speaker} must not contain control characters`);
  const n = charCount(name);
  if (n > SPEAKER_NAME_MAX) throw badRequest(`the name of ${speaker} is ${n} characters; the limit is ${SPEAKER_NAME_MAX}`);
  return name;
}

/** The speakers of a transcript in the order they first speak. */
export const speakersIn = (segments: readonly TranscriptSegment[]): string[] =>
  [...new Set(segments.flatMap((s) => (s.speaker ? [s.speaker] : [])))];

function requireKnown(present: readonly string[], names: Record<string, string>): void {
  const unknown = Object.keys(names).filter((k) => !present.includes(k));
  if (!unknown.length) return;
  throw badRequest(`unknown speaker ${unknown.join(', ')}; the transcript has ${present.length ? present.join(', ') : 'none'}`);
}

/** The user's names: each set with by "user" (confirming an agent's name makes it the user's); '' clears one. */
export function applyUserNames(current: SpeakerNames, present: readonly string[], names: Record<string, string>, now: Date): SpeakerNames {
  requireKnown(present, names);
  const next: SpeakerNames = { ...current };
  for (const [speaker, raw] of Object.entries(names)) {
    const name = cleanSpeakerName(raw, speaker);
    if (name) next[speaker] = { name, by: 'user', at: now.toISOString() };
    else delete next[speaker];
  }
  return next;
}

export type AgentNaming = { speakers: SpeakerNames; written: Record<string, string>; skipped: Array<{ speaker: string; reason: string }> };

/**
 * An agent's names: written where the speaker has no name or one an agent gave; a name from the user is never
 * replaced. Every name is checked before anything changes, so a bad one writes nothing.
 */
export function applyAgentNames(current: SpeakerNames, present: readonly string[], names: Record<string, string>, now: Date): AgentNaming {
  requireKnown(present, names);
  const next: SpeakerNames = { ...current };
  const written: Record<string, string> = {};
  const skipped: AgentNaming['skipped'] = [];
  for (const [speaker, raw] of Object.entries(names)) {
    const name = cleanSpeakerName(raw, speaker);
    if (!name) throw badRequest(`the name of ${speaker} is empty; pass a name, or leave the speaker out`);
    const had = current[speaker];
    if (had?.by === 'user') {
      skipped.push({ speaker, reason: `the user named ${speaker} "${had.name}"; a name from the user is never replaced` });
      continue;
    }
    next[speaker] = { name, by: 'agent', at: now.toISOString() };
    written[speaker] = name;
  }
  return { speakers: next, written, skipped };
}

/** This report's names first, then the project's; the newest first; each name once whatever its case; at most 20. */
export function rankNames(rows: ReadonlyArray<{ reportId: string; speakers: SpeakerNames }>, reportId: string): string[] {
  const all = rows.flatMap((r) => Object.values(r.speakers).map((s) => ({ name: s.name, at: s.at ?? '', here: r.reportId === reportId })));
  all.sort((a, b) => Number(b.here) - Number(a.here) || b.at.localeCompare(a.at));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of all) {
    const key = x.name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x.name);
    if (out.length === SUGGESTIONS_MAX) break;
  }
  return out;
}

export type SpeakerView = { header: string | null; labels: Record<string, string> | null };

/**
 * How an agent sees the speakers: a header line and the label of each speaker's lines. With one speaker (or none
 * recognized) both are null and the lines look as before; a failed recognition has only the header.
 */
export function speakerView(segments: readonly TranscriptSegment[], diarization: Diarization | null, speakers: SpeakerNames): SpeakerView {
  if (!diarization) return { header: null, labels: null };
  if ('error' in diarization) return { header: `Speakers not recognized: ${diarization.error}`, labels: null };
  if (diarization.speakers <= 1) return { header: null, labels: null };
  const ids = speakersIn(segments);
  if (!ids.length) return { header: null, labels: null };
  const parts = ids.map((id) => {
    const s = speakers[id];
    return s ? `${id} = ${s.name} (named by ${s.by === 'user' ? 'user' : 'Claude'})` : `${id} = not named`;
  });
  return { header: `Speakers: ${parts.join(', ')}`, labels: Object.fromEntries(ids.map((id) => [id, speakers[id]?.name ?? id])) };
}

/** The worker's diarization as stored: an error on one line of at most 2 000 characters, or a model and a count. */
export function cleanDiarization(input: Diarization | null | undefined): Diarization | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw badRequest('diarization must be an object, or null');
  const raw: Record<string, unknown> = input;
  if ('error' in raw) {
    if (typeof raw.error !== 'string') throw badRequest('diarization.error must be a string');
    const error = raw.error.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim() || 'unknown error';
    if (charCount(error) > DIARIZATION_ERROR_MAX) throw badRequest(`diarization.error is longer than ${DIARIZATION_ERROR_MAX} characters`);
    return { error };
  }
  if (typeof raw.model !== 'string' || !MODEL_NAME.test(raw.model)) throw badRequest('diarization.model must be a model name such as "pyannote/speaker-diarization-community-1"');
  if (typeof raw.speakers !== 'number' || !Number.isInteger(raw.speakers) || raw.speakers < 0 || raw.speakers > 99) {
    throw badRequest('diarization.speakers must be a whole number from 0 to 99');
  }
  return { model: raw.model, speakers: raw.speakers };
}

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The transcript's segments, names and speaker recognition, locked: two people naming at once must not undo each other. */
export async function lockedTranscript(tx: Tx, attachmentId: string) {
  const [t] = await tx
    .select({ segments: reportTranscripts.segments, speakers: reportTranscripts.speakers, diarization: reportTranscripts.diarization })
    .from(reportTranscripts)
    .where(eq(reportTranscripts.attachmentId, attachmentId))
    .for('update');
  if (!t) throw notFound(`attachment ${attachmentId} has no transcript yet`);
  return t;
}

/** The UI's names (by "user"); returns all names after the change. */
export async function setSpeakerNames(db: Db, attachmentId: string, names: Record<string, string>, now = new Date()): Promise<SpeakerNames> {
  return db.transaction(async (tx) => {
    const t = await lockedTranscript(tx, attachmentId);
    const speakers = applyUserNames(t.speakers, speakersIn(t.segments), names, now);
    await tx.update(reportTranscripts).set({ speakers }).where(eq(reportTranscripts.attachmentId, attachmentId));
    return speakers;
  });
}

/** name_speakers: an agent's names (by "agent"), under applyAgentNames' rules. */
export async function nameSpeakersAsAgent(db: Db, attachmentId: string, names: Record<string, string>, now = new Date()): Promise<AgentNaming> {
  return db.transaction(async (tx) => {
    const t = await lockedTranscript(tx, attachmentId);
    const r = applyAgentNames(t.speakers, speakersIn(t.segments), names, now);
    await tx.update(reportTranscripts).set({ speakers: r.speakers }).where(eq(reportTranscripts.attachmentId, attachmentId));
    return r;
  });
}

/** Names used in the transcripts of this report, then of its project (see rankNames); a report without a project has only its own. */
export async function speakerNameSuggestions(db: Db, reportId: string): Promise<string[]> {
  const [report] = await db.select({ projectId: reports.projectId }).from(reports).where(eq(reports.id, reportId));
  if (!report) throw notFound(`report ${reportId} does not exist`);
  const scope = report.projectId === null ? eq(reports.id, reportId) : eq(reports.projectId, report.projectId);
  const rows = await db
    .select({ reportId: reportAttachments.reportId, speakers: reportTranscripts.speakers })
    .from(reportTranscripts)
    .innerJoin(reportAttachments, eq(reportAttachments.id, reportTranscripts.attachmentId))
    .innerJoin(reports, eq(reports.id, reportAttachments.reportId))
    .where(and(scope, sql`${reportTranscripts.speakers} <> '{}'::jsonb`));
  return rankNames(rows, reportId);
}

import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { type Diarization, reportJobs, reportTranscripts, type SegmentEdit, type TranscriptSegment } from '../db/schema.js';
import { badRequest, conflict, DomainError, notFound } from './errors.js';
import { parseTimestamp } from './reports.js';
import { lockedTranscript, type Tx } from './speakers.js';
import { clock, collapseSpaces, segmentsChars, TRANSCRIPT_LIMITS, transcriptText } from './transcripts.js';
import { charCount, rejectNul } from './validation.js';

/** edit_transcript takes at most this many edits in one call. */
export const AGENT_EDITS_MAX = 50;

/** The speakers a line may be given: S1 … Sn of the recording's speaker recognition; none without one. */
export function allowedSpeakers(diarization: Diarization | null): string[] {
  if (!diarization || 'error' in diarization) return [];
  return Array.from({ length: diarization.speakers }, (_, i) => `S${i + 1}`);
}

/** Why a line's new text cannot be stored, or null when it can. */
function textProblem(text: string): string | null {
  if (!text) return 'the line would be empty';
  const n = charCount(text);
  if (n > TRANSCRIPT_LIMITS.segmentChars) return `the line would be ${n} characters; the limit is ${TRANSCRIPT_LIMITS.segmentChars}`;
  return null;
}

/** The user's text for a line: whitespace collapsed like the worker's lines; empty or over 2 000 characters is a 400. */
function cleanLineText(raw: string): string {
  rejectNul(raw, 'text');
  const text = collapseSpaces(raw);
  if (!text) throw badRequest("text is empty; a line needs words (Restore original brings back the worker's)");
  const n = charCount(text);
  if (n > TRANSCRIPT_LIMITS.segmentChars) throw badRequest(`text is ${n} characters; the limit is ${TRANSCRIPT_LIMITS.segmentChars}`);
  return text;
}

/** The line after an edit: the worker's text and speaker are kept from the first edit; `by` and `at` are the last editor's. */
export function editedLine(
  seg: TranscriptSegment,
  change: { text?: string; speaker?: string },
  by: SegmentEdit['by'],
  now: Date,
): TranscriptSegment {
  const text = change.text ?? seg.text;
  const speaker = change.speaker ?? seg.speaker;
  const original = seg.edit?.original ?? { text: seg.text, ...(seg.speaker ? { speaker: seg.speaker } : {}) };
  return { start_ms: seg.start_ms, end_ms: seg.end_ms, text, ...(speaker ? { speaker } : {}), edit: { by, at: now.toISOString(), original } };
}

/** The line as the worker wrote it; an unedited line is returned as it is. */
export function restoredLine(seg: TranscriptSegment): TranscriptSegment {
  if (!seg.edit) return seg;
  const { text, speaker } = seg.edit.original;
  return { start_ms: seg.start_ms, end_ms: seg.end_ms, text, ...(speaker ? { speaker } : {}) };
}

export type AgentLineEdit = { at: string; from?: string; to?: string; speaker?: string };
export type CheckedEdit = AgentLineEdit & { ms: number };
export type AgentEditResult = {
  written: Array<{ at: string; text?: string; speaker?: string }>;
  skipped: Array<{ at: string; reason: string }>;
};

/** The shape of every edit, checked before the transcript is read, so a malformed call writes nothing. */
export function checkAgentEdits(edits: readonly AgentLineEdit[]): CheckedEdit[] {
  if (edits.length === 0) throw badRequest('edits is empty; pass e.g. [{"at": "0:12", "from": "Tabla", "to": "Tabula"}]');
  if (edits.length > AGENT_EDITS_MAX) throw badRequest(`${edits.length} edits; at most ${AGENT_EDITS_MAX} in one call`);
  return edits.map((e, i) => {
    const n = `edit ${i + 1}`;
    if ((e.from === undefined) !== (e.to === undefined)) throw badRequest(`${n}: pass from and to together`);
    if (e.from === undefined && e.speaker === undefined) throw badRequest(`${n}: pass from and to, speaker, or both`);
    if (e.from === '') throw badRequest(`${n}: from is empty`);
    if (e.from !== undefined) rejectNul(e.from, `${n} from`);
    if (e.to !== undefined) rejectNul(e.to, `${n} to`);
    let ms: number;
    try {
      ms = parseTimestamp(e.at);
    } catch (err) {
      if (err instanceof DomainError) throw badRequest(`${n}: ${err.message}`);
      throw err;
    }
    return { ...e, ms };
  });
}

/**
 * An agent's edits, one after the other on a copy of the lines. Each finds the line starting in the second of `at`
 * (by `from` when several do); a line the user edited, an unknown speaker, a `from` not in the line, or a result that
 * would be empty or too long is skipped with the reason. Only the first exact occurrence of `from` is replaced.
 */
export function applyAgentEdits(
  segments: readonly TranscriptSegment[],
  diarization: Diarization | null,
  edits: readonly CheckedEdit[],
  now: Date,
): AgentEditResult & { segments: TranscriptSegment[] } {
  const out = [...segments];
  const allowed = allowedSpeakers(diarization);
  const written: AgentEditResult['written'] = [];
  const skipped: AgentEditResult['skipped'] = [];
  for (const e of edits) {
    const at = clock(e.ms);
    const second = Math.floor(e.ms / 1000);
    const here = out.flatMap((s, i) => (Math.floor(s.start_ms / 1000) === second ? [i] : []));
    let index: number;
    if (here.length === 0) {
      skipped.push({ at, reason: `no line starts at ${at}` });
      continue;
    } else if (here.length === 1) {
      index = here[0]!;
    } else if (e.from === undefined) {
      skipped.push({ at, reason: `${here.length} lines start at ${at}; pass from to pick one` });
      continue;
    } else {
      const from = e.from;
      const matching = here.filter((i) => out[i]!.text.includes(from));
      if (matching.length !== 1) {
        skipped.push({ at, reason: matching.length ? `${matching.length} lines at ${at} contain "${from}"; pass a longer from` : `no line at ${at} contains "${from}"` });
        continue;
      }
      index = matching[0]!;
    }
    const seg = out[index]!;
    if (seg.edit?.by === 'user') {
      skipped.push({ at, reason: 'the user edited this line; a line the user edited is never changed' });
      continue;
    }
    if (e.speaker !== undefined && !allowed.includes(e.speaker)) {
      skipped.push({ at, reason: `unknown speaker ${e.speaker}; the recording has ${allowed.length ? allowed.join(', ') : 'no speakers'}` });
      continue;
    }
    let text: string | undefined;
    if (e.from !== undefined) {
      const pos = seg.text.indexOf(e.from);
      if (pos < 0) {
        skipped.push({ at, reason: `"${e.from}" is not in the line` });
        continue;
      }
      text = collapseSpaces(seg.text.slice(0, pos) + e.to! + seg.text.slice(pos + e.from.length));
      const problem = textProblem(text);
      if (problem) {
        skipped.push({ at, reason: problem });
        continue;
      }
    }
    if ((text === undefined || text === seg.text) && (e.speaker === undefined || e.speaker === seg.speaker)) {
      skipped.push({ at, reason: 'nothing to change' });
      continue;
    }
    out[index] = editedLine(seg, { text, speaker: e.speaker }, 'agent', now);
    written.push({ at: clock(seg.start_ms), ...(text !== undefined ? { text } : {}), ...(e.speaker !== undefined ? { speaker: e.speaker } : {}) });
  }
  return { segments: out, written, skipped };
}

export const TRANSCRIBING_AGAIN = 'the recording is being transcribed again';

/** Whether "Transcribe again" is queued or running for the recording: the new transcript will replace every line. */
async function transcribingAgain(tx: Tx, attachmentId: string): Promise<boolean> {
  const [job] = await tx
    .select({ id: reportJobs.id })
    .from(reportJobs)
    .where(and(eq(reportJobs.attachmentId, attachmentId), inArray(reportJobs.status, ['queued', 'running'])));
  return !!job;
}

/** The line changed since the user saw it (Claude edited it, or a new transcript came in): 409 with the current line. */
export class SegmentChangedError extends DomainError {
  constructor(readonly current: TranscriptSegment) {
    super('conflict', 'the line changed meanwhile (Claude edited it, or the recording was transcribed again); its current text is in "current"');
  }
}

function lineAt(segments: readonly TranscriptSegment[], index: number): TranscriptSegment {
  const seg = segments[index];
  if (!seg) throw notFound(`the transcript has no line ${index} (it has ${segments.length})`);
  return seg;
}

/** The lines and the search text, written together. */
async function saveSegments(tx: Tx, attachmentId: string, segments: TranscriptSegment[]): Promise<void> {
  if (segmentsChars(segments) > TRANSCRIPT_LIMITS.totalChars) throw badRequest(`the transcript would be longer than ${TRANSCRIPT_LIMITS.totalChars} characters`);
  await tx.update(reportTranscripts).set({ segments, text: transcriptText(segments) }).where(eq(reportTranscripts.attachmentId, attachmentId));
}

export type LineInput = { text?: string; speaker?: string; expected: { text: string; speaker?: string | null } };

/**
 * The user's correction of one line (by "user"). `expected` is the line as the user saw it; when the stored line
 * differs, nothing is written and SegmentChangedError carries the current one. Saving a line unchanged writes nothing,
 * unless an agent edited it: then it becomes the user's.
 */
export async function editSegmentAsUser(db: Db, attachmentId: string, index: number, input: LineInput, now = new Date()): Promise<void> {
  if (input.text === undefined && input.speaker === undefined) throw badRequest('pass text or speaker');
  const text = input.text === undefined ? undefined : cleanLineText(input.text);
  await db.transaction(async (tx) => {
    const t = await lockedTranscript(tx, attachmentId);
    if (await transcribingAgain(tx, attachmentId)) throw conflict(`${TRANSCRIBING_AGAIN}; lines can be edited when the new transcript is in`);
    const seg = lineAt(t.segments, index);
    if (seg.text !== input.expected.text || (seg.speaker ?? null) !== (input.expected.speaker ?? null)) throw new SegmentChangedError(seg);
    if (input.speaker !== undefined) {
      const allowed = allowedSpeakers(t.diarization);
      if (!allowed.includes(input.speaker)) {
        throw badRequest(`unknown speaker ${input.speaker}; the recording has ${allowed.length ? allowed.join(', ') : 'no speakers'}`);
      }
    }
    const nextText = text ?? seg.text;
    const nextSpeaker = input.speaker ?? seg.speaker;
    if (!seg.edit && nextText === seg.text && nextSpeaker === seg.speaker) return;
    const line = editedLine(seg, { text, speaker: input.speaker }, 'user', now);
    await saveSegments(tx, attachmentId, t.segments.map((s, i) => (i === index ? line : s)));
  });
}

/** "Restore original": the worker's text and speaker come back and the edit is gone. */
export async function restoreSegment(db: Db, attachmentId: string, index: number): Promise<void> {
  await db.transaction(async (tx) => {
    const t = await lockedTranscript(tx, attachmentId);
    if (await transcribingAgain(tx, attachmentId)) throw conflict(`${TRANSCRIBING_AGAIN}; lines can be edited when the new transcript is in`);
    const seg = lineAt(t.segments, index);
    if (!seg.edit) return;
    const line = restoredLine(seg);
    await saveSegments(tx, attachmentId, t.segments.map((s, i) => (i === index ? line : s)));
  });
}

/** edit_transcript: an agent's corrections under applyAgentEdits' rules; written only when at least one applies. */
export async function editTranscriptAsAgent(db: Db, attachmentId: string, edits: readonly AgentLineEdit[], now = new Date()): Promise<AgentEditResult> {
  const checked = checkAgentEdits(edits);
  return db.transaction(async (tx) => {
    const t = await lockedTranscript(tx, attachmentId);
    if (await transcribingAgain(tx, attachmentId)) {
      return { written: [], skipped: checked.map((e) => ({ at: clock(e.ms), reason: TRANSCRIBING_AGAIN })) };
    }
    const r = applyAgentEdits(t.segments, t.diarization, checked, now);
    if (r.written.length) await saveSegments(tx, attachmentId, r.segments);
    return { written: r.written, skipped: r.skipped };
  });
}

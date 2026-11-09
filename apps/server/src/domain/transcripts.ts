import { importCli } from '../cli-package.js';
import type { TranscriptSegment } from '../db/schema.js';
import { badRequest } from './errors.js';
import { SPEAKER_ID } from './speakers.js';
import { rejectNul } from './validation.js';

export type { TranscriptSegment };

/** What one finished transcription may carry; no recording is longer than 24 hours. */
export const TRANSCRIPT_LIMITS = { segments: 20_000, segmentChars: 2_000, totalChars: 500_000, maxMs: 24 * 3600 * 1000 } as const;

// One formatter for the server and the CLI worker (see cli-package.ts).
type CliClock = { formatClock(ms: number): string };
const cli = await importCli<CliClock>();

/** "0:05", "2:41", "1:02:03": the same form as the UI's clock. */
export const clock: (ms: number) => string = cli.formatClock;

/** A segment as the worker sends it: `speaker` null means no label; a worker never sends edits. */
export type IncomingSegment = Omit<TranscriptSegment, 'speaker' | 'edit'> & { speaker?: string | null };

/** A line's text as stored: whitespace collapsed, trimmed. One rule for the worker's lines and the edited ones. */
export const collapseSpaces = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The transcript's size as the limit counts it: the sum of the lines' text lengths. */
export const segmentsChars = (segments: readonly TranscriptSegment[]): number => segments.reduce((n, s) => n + s.text.length, 0);

/**
 * Segments from a worker as they are stored: whole milliseconds, whitespace collapsed, empty ones dropped, in time
 * order. Anything out of range is a 400, so a broken worker can't store nonsense.
 */
export function cleanSegments(raw: readonly IncomingSegment[]): TranscriptSegment[] {
  if (raw.length > TRANSCRIPT_LIMITS.segments) {
    throw badRequest(`${raw.length} segments; the limit is ${TRANSCRIPT_LIMITS.segments}`);
  }
  const out: TranscriptSegment[] = [];
  let total = 0;
  for (const [i, s] of raw.entries()) {
    const start = Math.round(s.start_ms);
    const end = Math.round(s.end_ms);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > TRANSCRIPT_LIMITS.maxMs) {
      throw badRequest(`segment ${i}: start_ms and end_ms must satisfy 0 <= start_ms <= end_ms <= 24 h`);
    }
    rejectNul(s.text, `segment ${i} text`);
    const text = collapseSpaces(s.text);
    if (!text) continue;
    if (text.length > TRANSCRIPT_LIMITS.segmentChars) {
      throw badRequest(`segment ${i} has ${text.length} characters; the limit is ${TRANSCRIPT_LIMITS.segmentChars}`);
    }
    total += text.length;
    if (total > TRANSCRIPT_LIMITS.totalChars) throw badRequest(`the transcript is longer than ${TRANSCRIPT_LIMITS.totalChars} characters`);
    // null or absent: no label for this line.
    const speaker: unknown = s.speaker ?? undefined;
    if (speaker !== undefined && (typeof speaker !== 'string' || !SPEAKER_ID.test(speaker))) {
      throw badRequest(`segment ${i}: speaker must be S1 … S99`);
    }
    out.push({ start_ms: start, end_ms: end, text, ...(speaker !== undefined ? { speaker } : {}) });
  }
  return out.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
}

/** The text stored for full-text search: one segment per line. */
export const transcriptText = (segments: readonly TranscriptSegment[]): string => segments.map((s) => s.text).join('\n');

/** The compact form agents read: "[2:41] text" per line, "[2:41] Eva: text" when speakers are labelled. */
export const transcriptLines = (segments: readonly TranscriptSegment[], labels?: Record<string, string> | null): string =>
  segments
    .map((s) => `[${clock(s.start_ms)}] ${labels && s.speaker ? `${labels[s.speaker] ?? s.speaker}: ` : ''}${s.text}`)
    .join('\n');

/**
 * At most `limit` characters of `text` from `offset`, ending at a line break when one is in reach, and the offset of
 * the next part (null at the end). A line never exceeds the limit (segments are at most 2 000 characters).
 */
export function sliceLines(text: string, offset: number, limit: number): { text: string; next: number | null } {
  const from = Math.max(0, Math.min(Math.trunc(offset), text.length));
  if (from + limit >= text.length) return { text: text.slice(from), next: null };
  const cut = text.lastIndexOf('\n', from + limit);
  if (cut > from) return { text: text.slice(from, cut), next: cut + 1 };
  return { text: text.slice(from, from + limit), next: from + limit };
}

import type { TranscriptProgress } from '../../types';

/**
 * Fornax's note on a waiting job in words for people: without its leading "waiting:" (the line says it already) and
 * without the advice for agents that asking again changes nothing.
 */
export function noteForPeople(note: string | null | undefined): string | null {
  if (!note) return null;
  return note.replace(/^waiting\s*[:,]\s*/i, '').replace(/[,;]?\s*asking again changes nothing\.?$/i, '').trim() || null;
}

/** " 42 % · transcribing 01:23 / 10:00": how far Fornax is, with its message when it is short. */
export function progressText(p: TranscriptProgress): string {
  const parts: string[] = [];
  if (p.progress != null) parts.push(`${p.progress} %`);
  if (p.progressMessage && p.progressMessage.length <= 60) parts.push(p.progressMessage);
  return parts.length ? ` ${parts.join(' · ')}` : '';
}

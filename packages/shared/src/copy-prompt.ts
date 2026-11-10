// The prompt texts Home copies for Claude: the Copy for Claude text and its checks, shared by the tidy text. No imports: @tabula/shared stays dependency-free.

export const DEFAULT_COPY_PROMPT = 'Process report {ref}.';
/** Characters (code points) a stored prompt text may have (the Copy for Claude and the tidy text). */
export const COPY_PROMPT_MAX = 4000;
/** Where the report's reference goes. */
export const REF_PLACEHOLDER = '{ref}';

/** The text as it is stored: Windows line ends become new lines, and the ends are trimmed. */
export const normalizeCopyPrompt = (raw: string): string => raw.replace(/\r\n/g, '\n').trim();

const NUL = String.fromCharCode(0);
/** Control characters (C0, DEL and C1) other than the line feed (NUL is checked on its own). */
const CONTROL = /[\x01-\x09\x0b-\x1f\x7f-\x9f]/;

/** Why a normalized text can't be stored, or null when it can. */
export function copyPromptProblem(text: string): string | null {
  const n = [...text].length;
  if (n > COPY_PROMPT_MAX) return `text is ${n} characters; the limit is ${COPY_PROMPT_MAX}`;
  if (text.includes(NUL) || CONTROL.test(text)) return 'text must not contain control characters other than a new line';
  return null;
}

/** What is copied: every `{ref}` becomes the reference; a text without one gets the reference at the end, after a space. */
export function fillCopyPrompt(text: string, ref: string): string {
  return text.includes(REF_PLACEHOLDER) ? text.split(REF_PLACEHOLDER).join(ref) : `${text} ${ref}`;
}

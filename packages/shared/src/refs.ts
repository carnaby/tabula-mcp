// References to Tabula records ("tabula:d86d86e7"). No imports: @tabula/shared stays dependency-free.

export const REF_PREFIX = 'tabula:';

/** A record's reference: `tabula:` and the first 8 hex characters of its uuid. */
export const refOf = (id: string): string => `${REF_PREFIX}${id.slice(0, 8).toLowerCase()}`;

/**
 * What a reference picks up when it is copied out of a chat: quotes, backticks and Markdown wrappers around it
 * (`(…)`, `[…]`, `<…>`, `**…**`, `_…_`), and the punctuation after it.
 */
const WRAP_START = /^[`'"“”‘’([<*_]+/;
const WRAP_END = /[`'"“”‘’)\]>*_.,;:!?]+$/;

/**
 * The reference a search query consists of, normalized (`tabula:` + 4–32 hex characters, dashes ignored), or null when the query is anything else. Spaces and letter case do not matter.
 */
export function refQuery(q: string): string | null {
  const v = q.replace(/\s+/g, '').toLowerCase().replace(WRAP_START, '').replace(WRAP_END, '');
  if (!/^tabula:[0-9a-f-]{4,36}$/.test(v)) return null;
  const hex = v.slice(REF_PREFIX.length).replace(/-/g, '').length;
  return hex >= 4 && hex <= 32 ? v : null;
}

/**
 * A reference in running text: `tabula:` and exactly 8 hex characters, not glued to a word on the left and not
 * followed by more word characters (a full uuid, dashed or not, after the prefix is not a short reference). The only place the pattern lives.
 */
const REF_IN_TEXT = /(?<!\w)tabula:[0-9a-f]{8}(?!\w|-[0-9a-f]{4})/.source;

export interface RefMatch { index: number; length: number; ref: string }

/** The first reference in `text`, its ref lowercased, or null. */
export function findRef(text: string): RefMatch | null {
  const m = new RegExp(REF_IN_TEXT, 'i').exec(text);
  return m ? { index: m.index, length: m[0].length, ref: m[0].toLowerCase() } : null;
}

/** `text` cut into plain strings and `{ ref }` pieces (lowercased), in order. Empty text gives an empty list. */
export function splitRefs(text: string): Array<string | { ref: string }> {
  const out: Array<string | { ref: string }> = [];
  let offset = 0;
  const re = new RegExp(REF_IN_TEXT, 'gi');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > offset) out.push(text.slice(offset, m.index));
    out.push({ ref: m[0].toLowerCase() });
    offset = m.index + m[0].length;
  }
  const rest = text.slice(offset);
  if (rest) out.push(rest);
  return out;
}

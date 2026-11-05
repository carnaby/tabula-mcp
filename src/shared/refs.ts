// References to Tabula records ("tabula:d86d86e7"). No imports: the web UI builds this file too.

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

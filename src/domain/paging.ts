import { type SQL, sql } from 'drizzle-orm';

export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };
export type SortDir = 'asc' | 'desc';
export type PageQuery<S extends string> = { page?: number; pageSize?: number; sort?: S; dir?: SortDir };

export const MAX_PAGE_SIZE = 100;

export function pageWindow(p: { page?: number; pageSize?: number }) {
  const pageSize = Math.min(Math.max(Math.trunc(p.pageSize ?? 25), 1), MAX_PAGE_SIZE);
  const page = Math.max(Math.trunc(p.page ?? 1), 1);
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

/**
 * Search-as-you-type query: every word must match as a prefix ("drizz ord" finds "Drizzle over Prisma").
 * Only letters, combining marks and digits survive (input is NFC-normalized first), so user input can never produce invalid tsquery syntax.
 */
export function prefixTsQuery(q: string | undefined): string | undefined {
  const words = q?.normalize('NFC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu);
  return words?.length ? words.map((w) => `${w}:*`).join(' & ') : undefined;
}

export const matchesPrefix = (column: SQL | unknown, tsq: string): SQL =>
  sql`${column} @@ to_tsquery('tabula', ${tsq})`;

/** A "quoted phrase", OR (any case, as websearch_to_tsquery reads it) or -exclusion at the start of a word. */
const WEBSEARCH_SYNTAX = /"|(^|\s)or(\s|$)|(^|\s)-[^\s-]/i;

export const usesWebsearchSyntax = (q: string): boolean => WEBSEARCH_SYNTAX.test(q);

/**
 * The tsquery of a search box that also takes websearch syntax: a plain query matches every word as a prefix (prefixTsQuery),
 * a query with a "quoted phrase", OR or -exclusion keeps websearch_to_tsquery semantics (whole words). Input with no word at
 * all goes to websearch_to_tsquery too, which turns it into an empty query that matches nothing.
 */
export function searchTsQuery(q: string): SQL {
  const tsq = usesWebsearchSyntax(q) ? undefined : prefixTsQuery(q);
  return tsq ? sql`to_tsquery('tabula', ${tsq})` : sql`websearch_to_tsquery('tabula', ${q})`;
}

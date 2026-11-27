import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { reportDocuments } from '../db/schema.js';
import type { MediaStore } from '../media/store.js';
import type { Attachment } from './reports.js';
import type { Tx } from './speakers.js';
import { sliceLines } from './transcripts.js';

export const DOCUMENT_LIMITS = {
  chars: 1_000_000,
  fileBytes: 4 * 1024 * 1024,
  headLines: 100,
  headChars: 8_000,
  chunk: 50_000,
  headsPerReport: 3,
} as const;

export type DocumentReader = 'file' | 'fornax';

const FILE_MIMES = new Set(['text/plain', 'text/markdown']);
const FORNAX_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/** Who reads the text of a document: its own file, Fornax, or nobody (other types). Decided by the stored mime. */
export function documentReader(a: Pick<Attachment, 'kind' | 'mime'>): DocumentReader | null {
  if (a.kind !== 'document') return null;
  const mime = (a.mime.split(';')[0] ?? '').trim().toLowerCase();
  if (FILE_MIMES.has(mime)) return 'file';
  return FORNAX_MIMES.has(mime) ? 'fornax' : null;
}

/** Cut a text over the limit at the last line break before it, else hard at the limit (never inside a surrogate pair). */
export function cutText(raw: string, limit: number = DOCUMENT_LIMITS.chars): { text: string; truncated: boolean } {
  const part = sliceLines(raw, 0, limit);
  return { text: part.text, truncated: part.next !== null };
}

/**
 * The beginning of a document: the first lines, at most `headChars` characters. `prefix` is the start of the text
 * (at least `headChars + 1` characters, or all of it), `total` the length of the whole text. `next` is where the rest
 * starts (after a dropped line break), null when the beginning is the whole text.
 */
export function documentHead(prefix: string, total: number): { text: string; next: number | null } {
  let end = -1;
  for (let i = 0; i < DOCUMENT_LIMITS.headLines; i += 1) {
    end = prefix.indexOf('\n', end + 1);
    if (end === -1) break;
  }
  const region = end === -1 ? prefix : prefix.slice(0, end);
  const part = sliceLines(region, 0, DOCUMENT_LIMITS.headChars);
  const next = part.next ?? (end === -1 ? null : end + 1);
  return { text: part.text, next: next !== null && next >= total ? null : next };
}

/** A TXT/MD file read as UTF-8 up to `maxBytes` (BOM dropped, a broken character at the cut dropped). */
export async function readTextFile(
  store: MediaStore,
  key: string,
  maxBytes: number = DOCUMENT_LIMITS.fileBytes,
): Promise<{ text: string; truncated: boolean }> {
  const size = await store.size(key);
  const partial = size !== null && size > maxBytes;
  const decoder = new TextDecoder('utf-8');
  let text = '';
  for await (const chunk of store.open(key, { start: 0, end: maxBytes - 1 })) {
    text += decoder.decode(chunk as Buffer, { stream: true });
  }
  if (!partial) text += decoder.decode();
  const cut = cutText(text);
  return { text: cut.text, truncated: partial || cut.truncated };
}

export type DocumentInput = {
  text: string;
  source: DocumentReader;
  model: string | null;
  pages: number | null;
  tables: number | null;
  truncated?: boolean;
};

/** Store (or replace) the text of a document; NUL is dropped because Postgres text cannot hold it. */
export async function storeDocumentText(
  tx: Tx | Db,
  attachmentId: string,
  input: DocumentInput,
  now = new Date(),
): Promise<{ characters: number; truncated: boolean }> {
  const cut = cutText(input.text.replaceAll(String.fromCharCode(0), ''));
  const truncated = Boolean(input.truncated) || cut.truncated;
  const values = {
    text: cut.text, truncated, source: input.source, model: input.model, pages: input.pages, tables: input.tables,
    characters: cut.text.length, createdAt: now,
  };
  await tx.insert(reportDocuments).values({ attachmentId, ...values }).onConflictDoUpdate({ target: reportDocuments.attachmentId, set: values });
  return { characters: values.characters, truncated };
}

/** Store the text of a TXT/MD attachment from its file; false (nothing stored) when the file is gone. */
export async function storeFileText(db: Db, store: MediaStore, a: Attachment, now = new Date()): Promise<boolean> {
  if (a.purgedAt || (await store.size(a.storageKey)) === null) return false;
  const read = await readTextFile(store, a.storageKey);
  await storeDocumentText(db, a.id, { ...read, source: 'file', model: null, pages: null, tables: null }, now);
  return true;
}

export type DocumentText = {
  text: string;
  truncated: boolean;
  characters: number;
  source: DocumentReader;
  model: string | null;
  pages: number | null;
  tables: number | null;
  createdAt: Date;
};

export async function getDocumentText(db: Db, attachmentId: string): Promise<DocumentText | undefined> {
  const [row] = await db
    .select({
      text: reportDocuments.text, truncated: reportDocuments.truncated, characters: reportDocuments.characters,
      source: reportDocuments.source, model: reportDocuments.model, pages: reportDocuments.pages,
      tables: reportDocuments.tables, createdAt: reportDocuments.createdAt,
    })
    .from(reportDocuments)
    .where(eq(reportDocuments.attachmentId, attachmentId));
  return row;
}

/** The first `chars` characters of the stored texts (the database cuts them; whole texts are not read). */
export async function documentPrefixes(
  db: Db,
  attachmentIds: readonly string[],
  chars: number = DOCUMENT_LIMITS.headChars + 1,
): Promise<Map<string, string>> {
  if (attachmentIds.length === 0) return new Map();
  const rows = await db
    .select({ id: reportDocuments.attachmentId, prefix: sql<string>`substring(${reportDocuments.text} from 1 for ${chars})` })
    .from(reportDocuments)
    .where(inArray(reportDocuments.attachmentId, [...attachmentIds]));
  return new Map(rows.map((r) => [r.id, r.prefix]));
}

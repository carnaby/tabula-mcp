import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { reportAttachments, reportDocuments, reportJobs } from '../db/schema.js';
import type { MediaStore } from '../media/store.js';
import { badRequest, conflict, notFound } from './errors.js';
import { type PendingState, pendingState, startOver } from './jobs.js';
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

/** Queue Fornax reading of a PDF or Office document; one already queued, running, failed or done is left alone. */
export async function enqueueParse(db: Db, attachmentId: string, now = new Date()): Promise<void> {
  await db.insert(reportJobs).values({ attachmentId, kind: 'parse', runAfter: now }).onConflictDoNothing();
}

/**
 * Store the text Fornax read and finish the job, inside the caller's transaction (the sync checks there, under the same
 * lock, that the job is still the one Fornax finished). An empty text is stored too: the document was read, it has none.
 */
export async function storeParsedDocument(
  tx: Tx,
  jobId: string,
  input: Omit<DocumentInput, 'source'>,
  now = new Date(),
): Promise<{ characters: number }> {
  const [job] = await tx.select().from(reportJobs).where(eq(reportJobs.id, jobId)).for('update');
  if (!job) throw notFound(`job ${jobId} does not exist (the document was deleted?)`);
  const { characters } = await storeDocumentText(tx, job.attachmentId, { ...input, source: 'fornax' }, now);
  await tx
    .update(reportJobs)
    .set({ status: 'done', error: null, note: null, submitting: false, finishedAt: now, updatedAt: now })
    .where(eq(reportJobs.id, jobId));
  return { characters };
}

export type DocumentState =
  | { status: 'none' }
  | PendingState
  | {
      status: 'done'; source: DocumentReader; model: string | null; pages: number | null; tables: number | null;
      characters: number; truncated: boolean; createdAt: string;
    };

/** The text, or the state of its reading, for each document that has either; documents with neither are absent. */
export async function documentStates(db: Db, attachmentIds: readonly string[], now = new Date()): Promise<Map<string, DocumentState>> {
  const states = new Map<string, DocumentState>();
  if (!attachmentIds.length) return states;
  const ids = [...attachmentIds];
  const [jobs, texts] = await Promise.all([
    db
      .select({
        attachmentId: reportJobs.attachmentId, status: reportJobs.status, attempts: reportJobs.attempts, error: reportJobs.error,
        runAfter: reportJobs.runAfter, note: reportJobs.note, progress: reportJobs.progress, progressMessage: reportJobs.progressMessage,
      })
      .from(reportJobs)
      .where(and(inArray(reportJobs.attachmentId, ids), eq(reportJobs.kind, 'parse'))),
    db
      .select({
        attachmentId: reportDocuments.attachmentId, source: reportDocuments.source, model: reportDocuments.model, pages: reportDocuments.pages,
        tables: reportDocuments.tables, characters: reportDocuments.characters, truncated: reportDocuments.truncated,
        createdAt: reportDocuments.createdAt,
      })
      .from(reportDocuments)
      .where(inArray(reportDocuments.attachmentId, ids)),
  ]);
  for (const j of jobs) {
    if (j.status !== 'done') states.set(j.attachmentId, pendingState({ ...j, status: j.status }, now));
  }
  // A text wins over its job's state: it is what the user wants to see.
  for (const t of texts) {
    states.set(t.attachmentId, {
      status: 'done', source: t.source, model: t.model, pages: t.pages, tables: t.tables, characters: t.characters,
      truncated: t.truncated, createdAt: t.createdAt.toISOString(),
    });
  }
  return states;
}

const FORNAX_NEEDED = 'reading PDF and Office documents needs Fornax, which is not enabled on this server (no TABULA_FORNAX_URL)';
const FILE_GONE = 'the document was deleted after the report was closed; it can no longer be read';

/**
 * The UI's "Try again" for a document: a text file is read anew from its file; a PDF or Office document without a
 * text gets a Fornax job, or has its failed one started over. Returns the state the UI shows next.
 */
export async function retryDocument(
  db: Db,
  store: MediaStore,
  attachmentId: string,
  opts: { fornax: boolean },
  now = new Date(),
): Promise<DocumentState> {
  const [a] = await db.select().from(reportAttachments).where(eq(reportAttachments.id, attachmentId));
  if (!a) throw notFound(`attachment ${attachmentId} does not exist`);
  const reader = documentReader(a);
  if (reader === null) throw badRequest('only PDF, Office (DOCX, XLSX, PPTX), text and Markdown documents are read');
  if (a.purgedAt) throw conflict(FILE_GONE);
  if (reader === 'file') {
    if (!(await storeFileText(db, store, a, now))) throw conflict(FILE_GONE);
  } else {
    if (!opts.fornax) throw conflict(FORNAX_NEEDED);
    const [text] = await db.select({ id: reportDocuments.attachmentId }).from(reportDocuments).where(eq(reportDocuments.attachmentId, a.id));
    if (text) throw conflict('the document has been read already');
    const queued = await db
      .insert(reportJobs)
      .values({ attachmentId: a.id, kind: 'parse', runAfter: now })
      .onConflictDoUpdate({ target: [reportJobs.attachmentId, reportJobs.kind], set: startOver(now), setWhere: eq(reportJobs.status, 'failed') })
      .returning({ id: reportJobs.id });
    if (queued.length === 0) throw conflict('the document is already waiting for Fornax or being read');
  }
  return (await documentStates(db, [a.id], now)).get(a.id) ?? { status: 'none' };
}

/**
 * Documents uploaded before reading existed: the text of TXT and MD files is stored from disk, PDF and Office
 * documents on disk get a Fornax job (only when Fornax is on). Documents with a text, or a job of any state, are
 * left alone, so it can run at every start. A document that cannot be handled goes to onError and the rest go on.
 */
export async function backfillDocuments(
  db: Db,
  store: MediaStore,
  opts: { fornax: boolean; onError?: (e: unknown, attachmentId: string) => void },
  now = new Date(),
): Promise<{ texts: number; queued: number }> {
  const rows = await db
    .select({ a: reportAttachments, jobId: reportJobs.id })
    .from(reportAttachments)
    .leftJoin(reportDocuments, eq(reportDocuments.attachmentId, reportAttachments.id))
    .leftJoin(reportJobs, and(eq(reportJobs.attachmentId, reportAttachments.id), eq(reportJobs.kind, 'parse')))
    .where(and(eq(reportAttachments.kind, 'document'), isNull(reportAttachments.purgedAt), isNull(reportDocuments.attachmentId)));
  let texts = 0;
  let queued = 0;
  for (const { a, jobId } of rows) {
    try {
      const reader = documentReader(a);
      if (reader === 'file') {
        if (await storeFileText(db, store, a, now)) texts += 1;
      } else if (reader === 'fornax' && opts.fornax && jobId === null && (await store.size(a.storageKey)) !== null) {
        await enqueueParse(db, a.id, now);
        queued += 1;
      }
    } catch (e) {
      opts.onError?.(e, a.id);
    }
  }
  return { texts, queued };
}

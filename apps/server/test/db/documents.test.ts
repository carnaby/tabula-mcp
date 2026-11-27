import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { reportAttachments, reports } from '../../src/db/schema.js';
import { documentPrefixes, getDocumentText, readTextFile, storeDocumentText, storeFileText } from '../../src/domain/documents.js';
import { MediaStore } from '../../src/media/store.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const store = new MediaStore(mkdtempSync(join(tmpdir(), 'tabula-documents-media-')), 10 * 1024 * 1024);
beforeEach(() => seedProject(db, 'demo'));

/** A report with one document attachment, written straight to the database; the file only when `body` is given. */
async function document(opts: { mime?: string; ext?: string; body?: Buffer | null; purged?: boolean; closed?: boolean } = {}) {
  const [r] = await db
    .insert(reports)
    .values({
      projectId: 'demo', title: 'Minutes', source: 'human', editedBy: 'human',
      ...(opts.closed ? { status: 'done' as const, closedAt: new Date() } : {}),
    })
    .returning();
  const id = randomUUID();
  const key = `${r!.id}/${id}.${opts.ext ?? 'md'}`;
  const body = opts.body === undefined ? Buffer.from('x') : opts.body;
  if (body) await store.writeBuffer(key, body);
  const [a] = await db
    .insert(reportAttachments)
    .values({
      id, reportId: r!.id, kind: 'document', mime: opts.mime ?? 'text/markdown; charset=utf-8', size: body?.length ?? 0,
      sha256: 'x', fileName: `minutes.${opts.ext ?? 'md'}`, storageKey: key, createdBy: 'human',
      purgedAt: opts.purged ? new Date() : null,
    })
    .returning();
  return a!;
}

describe('document text', () => {
  it('reads a text file exactly, without the BOM', async () => {
    const a = await document({ body: Buffer.from('﻿# Zápis\r\n\n- [ ] úloha & ďalšia\n', 'utf8') });
    expect(await readTextFile(store, a.storageKey)).toEqual({ text: '# Zápis\r\n\n- [ ] úloha & ďalšia\n', truncated: false });
  });

  it('reads at most the first bytes of a text file, without a broken character at the end, and marks it truncated', async () => {
    const a = await document({ body: Buffer.from('ažž', 'utf8') }); // 1 + 2 + 2 bytes
    expect(await readTextFile(store, a.storageKey, 4)).toEqual({ text: 'až', truncated: true });
    expect(await readTextFile(store, a.storageKey, 5)).toEqual({ text: 'ažž', truncated: false });
  });

  it('stores a text with its counts, replaces it on a second store, strips NUL, and keeps it after the file is purged', async () => {
    const NUL = String.fromCharCode(0);
    const a = await document({ mime: 'application/pdf', ext: 'pdf' });
    expect(await storeDocumentText(db, a.id, { text: `a${NUL}b\n| x |`, source: 'fornax', model: 'docling 2.151.1', pages: 1, tables: 1 }))
      .toEqual({ characters: 8, truncated: false });
    await storeDocumentText(db, a.id, { text: 'z'.repeat(1_000_005), source: 'fornax', model: null, pages: null, tables: null });
    expect(await getDocumentText(db, a.id)).toMatchObject({ characters: 1_000_000, truncated: true, model: null, pages: null });
    await db.update(reportAttachments).set({ purgedAt: new Date() }).where(eq(reportAttachments.id, a.id));
    expect(await getDocumentText(db, a.id)).toBeDefined();
  });

  it('stores the text of a TXT or Markdown attachment from its file, and nothing when the file is gone', async () => {
    const md = await document({ body: Buffer.from('# Hello\n', 'utf8') });
    expect(await storeFileText(db, store, md)).toBe(true);
    expect(await getDocumentText(db, md.id)).toMatchObject({ text: '# Hello\n', source: 'file', model: null, characters: 8, truncated: false });
    const gone = await document({ body: null });
    expect(await storeFileText(db, store, gone)).toBe(false);
    expect(await getDocumentText(db, gone.id)).toBeUndefined();
  });

  it('gives the beginning of several texts without reading them whole', async () => {
    const a = await document();
    const b = await document();
    await storeDocumentText(db, a.id, { text: 'a'.repeat(10), source: 'file', model: null, pages: null, tables: null });
    await storeDocumentText(db, b.id, { text: 'b'.repeat(20_000), source: 'file', model: null, pages: null, tables: null });
    const p = await documentPrefixes(db, [a.id, b.id]);
    expect(p.get(a.id)).toHaveLength(10);
    expect(p.get(b.id)).toHaveLength(8_001);
  });
});

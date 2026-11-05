import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { memories, projectFiles, reportAttachments } from '../../src/db/schema.js';
import { deleteFile, putFile } from '../../src/domain/files.js';
import { createMemory, deprecateMemory } from '../../src/domain/memories.js';
import { createNote } from '../../src/domain/notes.js';
import { AmbiguousRefError, refTarget, resolveRecord } from '../../src/domain/records.js';
import { createReport, updateReport } from '../../src/domain/reports.js';
import { createThought, HUMAN, updateThought } from '../../src/domain/thoughts.js';
import { refOf } from '../../src/shared/refs.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();

let keys = 0;
async function attachment(reportId: string, kind: 'frame' | 'video', extra: Partial<typeof reportAttachments.$inferInsert> = {}) {
  const [row] = await db.insert(reportAttachments).values({
    reportId, kind, mime: kind === 'frame' ? 'image/jpeg' : 'video/mp4', size: 10, sha256: 'x',
    fileName: kind === 'frame' ? 'frame-0012.jpg' : 'screen.mp4', storageKey: `${reportId}/${++keys}.bin`, createdBy: 'human', ...extra,
  }).returning();
  return row!;
}

const MEMORY_ID = 'abcd1000-0000-4000-8000-000000000000';
const FILE_ID = 'abcd2000-0000-4000-8000-000000000000';
async function twoRecordsStartingWithAbcd() {
  await seedProject(db, 'demo');
  await db.insert(memories).values({ id: MEMORY_ID, projectId: 'global', kind: 'rule', title: 'First', body: 'b', source: 'human' });
  await db.insert(projectFiles).values({ id: FILE_ID, projectId: 'demo', path: 'docs/a.md', content: 'x', sha256: 'h', size: 1, updatedBy: 'cli' });
}

describe('resolveRecord', () => {
  it('finds every record type by its reference, inactive ones with their state', async () => {
    await seedProject(db, 'demo');
    const rule = await createMemory(db, { projectId: 'global', kind: 'rule', title: 'Old rule', body: 'b', source: 'human' });
    await deprecateMemory(db, rule.id, 'replaced');
    const note = await createNote(db, { projectId: 'demo', title: 'Arch note' });
    const thought = await createThought(db, { title: 'Idea' }, HUMAN);
    await updateThought(db, thought.id, { archived: true }, HUMAN);
    const report = await createReport(db, { projectId: 'demo', title: 'Login loops' }, HUMAN);
    await updateReport(db, report.id, { status: 'done' }, HUMAN);
    await putFile(db, 'demo', { path: 'docs/gone.md', content: 'last words', baseSha256: null }, 'cli');
    await deleteFile(db, 'demo', 'docs/gone.md');
    const [file] = await db.select().from(projectFiles).where(eq(projectFiles.path, 'docs/gone.md'));
    const video = await attachment(report.id, 'video', { purgedAt: new Date() });
    const frame = await attachment(report.id, 'frame', { sourceId: video.id, atMs: 12_000, note: 'Spinner' });

    const target = async (id: string) => refTarget(await resolveRecord(db, refOf(id)));
    expect(await target(rule.id)).toEqual({
      ref: refOf(rule.id), type: 'memory', id: rule.id, project: 'global', title: 'Old rule', kind: 'rule', status: 'deprecated',
    });
    expect(await target(note.id)).toEqual({ ref: refOf(note.id), type: 'note', id: note.id, project: 'demo', title: 'Arch note' });
    expect(await target(thought.id)).toMatchObject({ type: 'thought', project: null, title: 'Idea', status: 'archived' });
    expect(await target(report.id)).toMatchObject({ type: 'report', project: 'demo', title: 'Login loops', status: 'done' });
    expect(await target(file!.id)).toEqual({
      ref: refOf(file!.id), type: 'file', id: file!.id, project: 'demo', title: 'docs/gone.md', path: 'docs/gone.md', status: 'deleted',
    });
    expect(await target(video.id)).toMatchObject({ type: 'attachment', kind: 'video', report_id: report.id, project: 'demo', status: 'purged' });
    expect(await target(frame.id)).toMatchObject({
      type: 'attachment', kind: 'frame', report_id: report.id, project: 'demo', title: 'frame-0012.jpg', status: 'active',
    });
    expect(await resolveRecord(db, refOf(file!.id))).toMatchObject({ type: 'file', record: { content: 'last words' } });
    expect(await resolveRecord(db, refOf(frame.id))).toMatchObject({ type: 'attachment', record: { note: 'Spinner' }, report: { id: report.id } });
  });

  it('accepts a reference in every form', async () => {
    const t = await createThought(db, { title: 'Forms' }, HUMAN);
    const forms = [
      refOf(t.id), refOf(t.id).toUpperCase(), ` tabula: ${t.id.slice(0, 6)} `, `tabula:${t.id.slice(0, 13)}`,
      `tabula:${t.id.replace(/-/g, '')}`, `tabula:${t.id}`, t.id, t.id.toUpperCase(), `#${t.id.slice(0, 4)}`, t.id.slice(0, 6),
    ];
    for (const form of forms) expect((await resolveRecord(db, form)).record.id, form).toBe(t.id);
  });

  it('lists the candidates of an ambiguous reference with references long enough to tell them apart', async () => {
    await twoRecordsStartingWithAbcd();
    const err = await resolveRecord(db, 'tabula:abcd').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousRefError);
    const { candidates, message, code } = err as AmbiguousRefError;
    expect(code).toBe('bad_request');
    expect(candidates).toHaveLength(2);
    expect(candidates).toEqual(expect.arrayContaining([
      { type: 'memory', id: MEMORY_ID, ref: 'tabula:abcd1000', title: 'First' },
      { type: 'file', id: FILE_ID, ref: 'tabula:abcd2000', title: 'demo: docs/a.md' },
    ]));
    expect(message).toMatch(/^tabula:abcd is ambiguous; it matches .*tabula:abcd1000 \(memory: First\).*Pass more characters\.$/);
    expect((await resolveRecord(db, 'tabula:abcd2')).type).toBe('file');
    await expect(resolveRecord(db, 'tabula:ffff0000')).rejects.toMatchObject({ code: 'not_found', message: 'no record matches tabula:ffff0000' });
  });

  it('keeps the old #xxxx short id to rules, notes, thoughts and reports, so a rule from recall stays unambiguous', async () => {
    await twoRecordsStartingWithAbcd();
    expect((await resolveRecord(db, '#abcd')).type).toBe('memory');
    expect((await resolveRecord(db, 'abcd')).type).toBe('memory');
    await expect(resolveRecord(db, 'tabula:abcd')).rejects.toBeInstanceOf(AmbiguousRefError);
    expect((await resolveRecord(db, FILE_ID)).type).toBe('file');
  });
});

describe('resolveRecord with 8+ hex', () => {
  it('reaches files and attachments from a bare or # prefix, in any case', async () => {
    await seedProject(db, 'demo');
    const report = await createReport(db, { projectId: 'demo', title: 'Video' }, HUMAN);
    const frame = await attachment(report.id, 'frame');
    await putFile(db, 'demo', { path: 'docs/plan.md', content: 'x', baseSha256: null }, 'cli');
    const [file] = await db.select().from(projectFiles).where(eq(projectFiles.path, 'docs/plan.md'));
    for (const [id, type] of [[frame.id, 'attachment'], [file!.id, 'file']] as const) {
      const hex = id.slice(0, 8);
      for (const form of [hex, `#${hex}`, hex.toUpperCase(), `#${hex.toUpperCase()}`, `tabula:${hex}`, id.slice(0, 13)]) {
        expect((await resolveRecord(db, form)).type, form).toBe(type);
      }
    }
  });

  it('shows a missed 8+ hex id as a reference, without the short-id hint', async () => {
    await expect(resolveRecord(db, 'ffff0000')).rejects.toMatchObject({ code: 'not_found', message: 'no record matches tabula:ffff0000' });
  });
});

describe('resolveRecord misses', () => {
  it('points a missed old short id at the tabula: form for files and attachments', async () => {
    await expect(resolveRecord(db, '#ffff')).rejects.toMatchObject({
      code: 'not_found', message: 'no record matches #ffff; files and attachments are found with tabula:ffff',
    });
  });
});

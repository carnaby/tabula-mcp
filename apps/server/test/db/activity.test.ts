import { randomUUID } from 'node:crypto';
import { refOf } from '@tabula/shared/refs';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  notes, projectFileRevisions, projectFiles, reportAttachments, reports, reportTranscripts, thoughtRevisions, thoughts,
} from '../../src/db/schema.js';
import { type ActivityType, activityPage } from '../../src/domain/activity.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const T = (iso: string) => new Date(iso);
/** Pages end at the start of 10 November 2026 (UTC) unless a test says otherwise. */
const END = T('2026-11-10T00:00:00Z');
const page = (o: { before?: Date; type?: ActivityType; tz?: string } = {}) =>
  activityPage(db, { before: o.before ?? END, type: o.type, tz: o.tz ?? 'UTC' });
const items = async (o?: { before?: Date; type?: ActivityType; tz?: string }) => (await page(o)).days.flatMap((d) => d.items);

async function file(project: string, path: string, by: string, at: string, o: { version?: number; deleted?: boolean } = {}) {
  const [f] = await db
    .insert(projectFiles)
    .values({
      projectId: project, path, content: 'x', sha256: 'x', size: 1, updatedBy: by, version: o.version ?? 1,
      createdAt: T(at), updatedAt: T(at), deletedAt: o.deleted ? T(at) : null,
    })
    .returning();
  return f!;
}
async function fileRevision(fileId: string, version: number, by: string, at: string) {
  await db.insert(projectFileRevisions).values({ fileId, version, content: 'x', sha256: 'x', size: 1, updatedBy: by, createdAt: T(at) });
}
async function report(o: Partial<typeof reports.$inferInsert> & { created: string; updated?: string }) {
  const { created, updated, ...rest } = o;
  const [r] = await db
    .insert(reports)
    .values({ projectId: 'demo', title: 'Player freezes', source: 'human', editedBy: 'human', ...rest, createdAt: T(created), updatedAt: T(updated ?? created) })
    .returning();
  return r!;
}
async function recording(reportId: string, by: string, at: string) {
  const id = randomUUID();
  await db.insert(reportAttachments).values({
    id, reportId, kind: 'audio', mime: 'audio/wav', size: 10, sha256: 'x', fileName: 'voice.wav', storageKey: `${reportId}/${id}.wav`,
    createdBy: by, createdAt: T(at),
  });
  return id;
}
async function thought(o: { title?: string; by: string; created: string; updated?: string; version?: number; archived?: boolean }) {
  const [t] = await db
    .insert(thoughts)
    .values({
      title: o.title ?? 'Idea', source: o.by === 'human' ? 'human' : 'agent', editedBy: o.by, version: o.version ?? 1, archived: o.archived ?? false,
      createdAt: T(o.created), updatedAt: T(o.updated ?? o.created),
    })
    .returning();
  return t!;
}
async function note(o: { title?: string; project?: string; created: string; updated?: string }) {
  const [n] = await db
    .insert(notes)
    .values({ projectId: o.project ?? null, title: o.title ?? 'Note', createdAt: T(o.created), updatedAt: T(o.updated ?? o.created) })
    .returning();
  return n!;
}

describe('activity', () => {
  it('shows every source with its author and reference', async () => {
    await seedProject(db, 'demo');
    const f = await file('demo', 'docs/handoff/state.md', 'cli', '2026-11-09T08:00:00Z');
    const r = await report({ created: '2026-11-09T09:00:00Z' });
    const a = await recording(r.id, 'human', '2026-11-09T09:00:00Z');
    await db.insert(reportTranscripts).values({ attachmentId: a, model: 'large-v3', text: 'Ahoj', segments: [], createdAt: T('2026-11-09T09:30:00Z') });
    const t = await thought({ title: 'Saved from a chat', by: 'claude-ai', created: '2026-11-09T10:00:00Z' });
    const n = await note({ title: 'Shopping list', project: 'demo', created: '2026-11-09T11:00:00Z' });

    const p = await page();
    expect(p.next_before).toBeNull();
    expect(p.days.map((d) => d.date)).toEqual(['2026-11-09']);
    expect(p.days[0]!.items).toEqual([
      { type: 'note', action: 'New note', ref: refOf(n.id), id: n.id, title: 'Shopping list', project: 'demo', by: 'human', at: '2026-11-09T11:00:00.000Z' },
      { type: 'thought', action: 'Saved thought', ref: refOf(t.id), id: t.id, title: 'Saved from a chat', project: null, by: 'claude-ai', at: '2026-11-09T10:00:00.000Z' },
      {
        type: 'report', action: 'Transcribed', ref: refOf(a), id: r.id, attachment_id: a, title: 'Player freezes', project: 'demo', by: 'worker',
        at: '2026-11-09T09:30:00.000Z',
      },
      { type: 'report', action: 'New report', ref: refOf(r.id), id: r.id, title: 'Player freezes', project: 'demo', by: 'human', at: '2026-11-09T09:00:00.000Z' },
      {
        type: 'file', action: 'Pushed 1 file', ref: refOf(f.id), id: f.id, title: 'docs/handoff/state.md', path: 'docs/handoff/state.md', project: 'demo',
        by: 'cli', at: '2026-11-09T08:00:00.000Z',
      },
    ]);
  });

  it('turns the versions of a thought into rows: one per author within an hour', async () => {
    const t = await thought({ title: 'Plan', by: 'human', created: '2026-11-09T10:00:00Z', updated: '2026-11-09T13:31:00Z', version: 4 });
    await db.insert(thoughtRevisions).values([
      { thoughtId: t.id, version: 1, title: 'Plan', body: '', editedBy: 'claude-ai', createdAt: T('2026-11-09T10:00:00Z') },
      { thoughtId: t.id, version: 2, title: 'Plan', body: '', editedBy: 'human', createdAt: T('2026-11-09T12:00:00Z') },
      { thoughtId: t.id, version: 3, title: 'Plan', body: '', editedBy: 'human', createdAt: T('2026-11-09T12:30:00Z') },
    ]);
    // Created long ago, but its older versions are no longer kept: nothing older remains to show.
    await thought({ title: 'Pruned', by: 'human', created: '2026-09-01T10:00:00Z', updated: '2026-11-09T09:00:00Z', version: 30 });
    expect((await items()).map((i) => [i.action, i.by, i.at])).toEqual([
      ['Edited thought', 'human', '2026-11-09T13:31:00.000Z'],
      ['Edited thought', 'human', '2026-11-09T12:30:00.000Z'],
      ['Saved thought', 'claude-ai', '2026-11-09T10:00:00.000Z'],
      ['Edited thought', 'human', '2026-11-09T09:00:00.000Z'],
    ]);
    expect((await page()).next_before).toBeNull();
  });

  it('says what the last change of a report was and who made it', async () => {
    await seedProject(db, 'demo');
    await report({
      title: 'Triaged by Claude', created: '2026-11-09T08:00:00Z', updated: '2026-11-09T10:00:00Z', editedBy: 'claude-code', triage: 'Cause and tasks',
      status: 'triaged', version: 2,
    });
    await report({ title: 'Closed by you', created: '2026-11-09T07:00:00Z', updated: '2026-11-09T11:00:00Z', status: 'done', closedAt: T('2026-11-09T11:00:00Z'), version: 2 });
    const later = await report({ title: 'Recording added', created: '2026-11-09T06:00:00Z', updated: '2026-11-09T12:00:00Z', editedBy: 'claude-ai', version: 2 });
    await recording(later.id, 'human', '2026-11-09T12:00:00Z');
    await report({ title: 'Fixed a typo', created: '2026-11-09T05:00:00Z', updated: '2026-11-09T05:20:00Z', version: 2 });

    expect((await items()).map((i) => [i.title, i.action, i.by, i.at.slice(11, 16)])).toEqual([
      ['Recording added', 'Updated', 'human', '12:00'],
      ['Closed by you', 'Closed', 'human', '11:00'],
      ['Triaged by Claude', 'Triage written', 'claude-code', '10:00'],
      ['Triaged by Claude', 'New report', 'human', '08:00'],
      ['Closed by you', 'New report', 'human', '07:00'],
      ['Recording added', 'New report', 'human', '06:00'],
      ['Fixed a typo', 'New report', 'human', '05:20'],
    ]);
  });

  it('pages by 14 days: next_before is the start of the oldest day, null when nothing is older', async () => {
    await note({ title: 'Yesterday', created: '2026-11-09T12:00:00Z' });
    await note({ title: 'At the edge', created: '2026-10-27T00:00:00Z' });
    await note({ title: 'Long ago', created: '2026-10-05T12:00:00Z' });

    const first = await page();
    expect(first.days.flatMap((d) => d.items.map((i) => i.title))).toEqual(['Yesterday', 'At the edge']);
    expect(first.next_before).toBe('2026-10-27T00:00:00.000Z');
    // A quiet stretch: an empty page still says that older activity exists.
    const second = await page({ before: T(first.next_before!) });
    expect(second).toEqual({ days: [], next_before: '2026-10-13T00:00:00.000Z' });
    const third = await page({ before: T(second.next_before!) });
    expect(third.days.flatMap((d) => d.items.map((i) => i.title))).toEqual(['Long ago']);
    expect(third.next_before).toBeNull();
  });

  it('filters by type, and next_before follows the filter', async () => {
    await seedProject(db, 'demo');
    await file('demo', 'docs/a.md', 'cli', '2026-11-09T08:00:00Z');
    const r = await report({ created: '2026-11-09T09:00:00Z' });
    const a = await recording(r.id, 'human', '2026-11-09T09:00:00Z');
    await db.insert(reportTranscripts).values({ attachmentId: a, model: 'large-v3', text: 'Ahoj', segments: [], createdAt: T('2026-11-09T09:30:00Z') });
    await thought({ by: 'human', created: '2026-11-09T10:00:00Z' });
    await thought({ title: 'Old', by: 'human', created: '2026-09-01T10:00:00Z' });
    await note({ created: '2026-11-09T11:00:00Z' });

    const actions = async (type: ActivityType) => (await items({ type })).map((i) => i.action);
    expect(await actions('files')).toEqual(['Pushed 1 file']);
    expect(await actions('reports')).toEqual(['Transcribed', 'New report']);
    expect(await actions('thoughts')).toEqual(['Saved thought']);
    expect(await actions('notes')).toEqual(['New note']);
    expect((await page({ type: 'thoughts' })).next_before).toBe('2026-10-27T00:00:00.000Z');
    expect((await page({ type: 'notes' })).next_before).toBeNull();
  });

  it('leaves out archived thoughts and deleted files with their versions', async () => {
    await seedProject(db, 'demo');
    await thought({ title: 'Archived', by: 'human', created: '2026-11-09T10:00:00Z', archived: true });
    const gone = await file('demo', 'docs/gone.md', 'cli', '2026-11-09T09:00:00Z', { version: 2, deleted: true });
    await fileRevision(gone.id, 1, 'cli', '2026-11-09T08:00:00Z');
    await file('demo', 'docs/kept.md', 'human', '2026-11-09T07:00:00Z');

    const p = await page();
    expect(p.days.flatMap((d) => d.items.map((i) => i.title))).toEqual(['docs/kept.md']);
    expect(p.next_before).toBeNull();
  });

  it('makes one row of a push and keeps another author apart', async () => {
    await seedProject(db, 'demo');
    const a = await file('demo', 'docs/a.md', 'cli', '2026-11-09T08:04:00Z', { version: 2 });
    await fileRevision(a.id, 1, 'cli', '2026-11-09T08:00:00Z');
    const b = await file('demo', 'docs/b.md', 'cli', '2026-11-09T08:02:00Z');
    const c = await file('demo', 'docs/c.md', 'claude-code', '2026-11-09T08:03:00Z');

    expect(await items()).toEqual([
      {
        type: 'file', action: 'Pushed 2 files', ref: refOf(a.id), id: a.id, title: 'docs/a.md and 1 more', project: 'demo', by: 'cli',
        at: '2026-11-09T08:04:00.000Z', count: 2,
        children: [{ id: a.id, path: 'docs/a.md', ref: refOf(a.id) }, { id: b.id, path: 'docs/b.md', ref: refOf(b.id) }],
      },
      {
        type: 'file', action: 'Edited 1 file', ref: refOf(c.id), id: c.id, title: 'docs/c.md', path: 'docs/c.md', project: 'demo', by: 'claude-code',
        at: '2026-11-09T08:03:00.000Z',
      },
    ]);
  });

  it('shows a report without a project, and its transcript, with project null', async () => {
    const r = await report({ projectId: null, title: 'Weekly planning', created: '2026-11-09T09:00:00Z' });
    const a = await recording(r.id, 'human', '2026-11-09T09:00:00Z');
    await db.insert(reportTranscripts).values({ attachmentId: a, model: 'large-v3', text: 'Ahoj', segments: [], createdAt: T('2026-11-09T10:00:00Z') });
    expect((await items()).map((i) => [i.action, i.project])).toEqual([['Transcribed', null], ['New report', null]]);
    // Closing purges the recording's bytes, not its row or transcript: the rows stay.
    await db.update(reportAttachments).set({ purgedAt: T('2026-11-09T11:00:00Z') }).where(eq(reportAttachments.id, a));
    expect((await items()).map((i) => [i.action, i.project])).toEqual([['Transcribed', null], ['New report', null]]);
  });

  it('groups days in the time zone it is given', async () => {
    await note({ title: 'Late', created: '2026-11-08T23:30:00Z' });
    expect((await page({ tz: 'UTC' })).days.map((d) => d.date)).toEqual(['2026-11-08']);
    expect((await page({ tz: 'Europe/Bratislava' })).days.map((d) => d.date)).toEqual(['2026-11-09']);
  });
});

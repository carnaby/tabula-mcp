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
/** The first page (no `before`) at a given "now". */
const first = (now: string, o: { type?: ActivityType; tz?: string } = {}) => activityPage(db, { type: o.type, tz: o.tz ?? 'UTC', now: T(now) });
const titles = (p: { days: { items: { title: string }[] }[] }) => p.days.flatMap((d) => d.items.map((i) => i.title));
const minutes = (base: string, n: number) => new Date(T(base).getTime() + n * 60_000).toISOString();
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

  it('shows today and yesterday on the first page, in the zone it is given', async () => {
    await note({ title: 'Today', created: '2026-11-10T08:00:00Z' });
    await note({ title: 'Yesterday', created: '2026-11-09T12:00:00Z' });
    // 23:30 on 8 November in Bratislava: the day before yesterday there.
    await note({ title: 'Day before', created: '2026-11-08T22:30:00Z' });
    // 00:30 on 9 November in Bratislava: yesterday there, the 8th in UTC.
    await note({ title: 'Just yesterday', created: '2026-11-08T23:30:00Z' });

    const bratislava = await first('2026-11-10T12:00:00Z', { tz: 'Europe/Bratislava' });
    expect(titles(bratislava)).toEqual(['Today', 'Yesterday', 'Just yesterday']);
    expect(bratislava.days.map((d) => d.date)).toEqual(['2026-11-10', '2026-11-09']);
    expect(bratislava.next_before).toBe('2026-11-08T23:00:00.000Z');
    const utc = await first('2026-11-10T12:00:00Z');
    expect(titles(utc)).toEqual(['Today', 'Yesterday']);
    expect(utc.next_before).toBe('2026-11-09T00:00:00.000Z');
    // The next page starts at next_before and reaches back at any age.
    expect(titles(await page({ before: T(utc.next_before!) }))).toEqual(['Just yesterday', 'Day before']);
  });

  it('has no next_before on the first page when nothing is older', async () => {
    await note({ title: 'Today', created: '2026-11-10T08:00:00Z' });
    expect(await first('2026-11-10T12:00:00Z')).toMatchObject({ next_before: null });
    expect(await first('2026-11-10T12:00:00Z', { type: 'files' })).toEqual({ days: [], next_before: null });
  });

  it('cuts a page at 25 rows and loses and repeats nothing', async () => {
    for (let i = 0; i < 30; i++) await note({ title: `n${String(i).padStart(2, '0')}`, created: minutes('2026-11-09T10:00:00Z', i) });
    const all = Array.from({ length: 30 }, (_, i) => `n${String(29 - i).padStart(2, '0')}`);

    const one = await page();
    expect(titles(one)).toEqual(all.slice(0, 25));
    expect(one.next_before).toBe('2026-11-09T10:05:00.000Z');
    const two = await page({ before: T(one.next_before!) });
    expect(titles(two)).toEqual(all.slice(25));
    expect(two.next_before).toBeNull();
    // The first page (today and yesterday) obeys the same limit and leads to the same second page.
    const firstPage = await first('2026-11-10T06:00:00Z');
    expect(titles(firstPage)).toEqual(all.slice(0, 25));
    expect(firstPage.next_before).toBe(one.next_before);
  });

  it('keeps events with the same time on the same page', async () => {
    for (let i = 0; i < 22; i++) await note({ title: `new${i}`, created: minutes('2026-11-09T12:00:00Z', i) });
    for (let i = 0; i < 5; i++) await note({ title: `same${i}`, created: '2026-11-09T10:00:00Z' });
    for (let i = 0; i < 3; i++) await note({ title: `old${i}`, created: minutes('2026-11-09T08:00:00Z', i) });

    const one = await page();
    // 22 + 5 rows would be 27: the five with one time all go to the next page.
    expect(titles(one)).toHaveLength(22);
    expect(titles(one).every((t) => t.startsWith('new'))).toBe(true);
    expect(one.next_before).toBe('2026-11-09T12:00:00.000Z');
    const two = await page({ before: T(one.next_before!) });
    expect(titles(two).sort()).toEqual(['old0', 'old1', 'old2', 'same0', 'same1', 'same2', 'same3', 'same4']);
  });

  it('keeps a page whole when the newest time alone is over the limit', async () => {
    for (let i = 0; i < 27; i++) await note({ title: `same${i}`, created: '2026-11-09T10:00:00Z' });
    await note({ title: 'older', created: '2026-11-09T09:00:00Z' });
    const one = await page();
    expect(titles(one)).toHaveLength(27);
    expect(one.next_before).toBe('2026-11-09T10:00:00.000Z');
    expect(titles(await page({ before: T(one.next_before!) }))).toEqual(['older']);
  });

  it('splits a file batch cut by the row limit: newer files on one page, the rest on the next, none twice', async () => {
    await seedProject(db, 'demo');
    // Files every 4 minutes (one batch), a note two minutes after each: 30 of both, interleaved.
    for (let i = 0; i < 30; i++) {
      await file('demo', `docs/f${String(i).padStart(2, '0')}.md`, 'cli', minutes('2026-11-09T10:00:00Z', 4 * i));
      await note({ title: `n${String(i).padStart(2, '0')}`, created: minutes('2026-11-09T10:00:00Z', 4 * i + 2) });
    }
    const one = await page();
    const two = await page({ before: T(one.next_before!) });
    const batch = (p: typeof one) => p.days.flatMap((d) => d.items).find((i) => i.type === 'file')!;
    expect(one.days.flatMap((d) => d.items)).toHaveLength(25);
    expect(batch(one)).toMatchObject({ action: 'Pushed 24 files', count: 24 });
    expect(batch(two)).toMatchObject({ action: 'Pushed 6 files', count: 6 });
    const paths = [...batch(one).children!, ...batch(two).children!].map((c) => c.path);
    expect(new Set(paths).size).toBe(30);
    expect(batch(one).children!.every((c) => c.path >= 'docs/f06.md')).toBe(true);
    const noteTitles = [...titles(one), ...titles(two)].filter((t) => t.startsWith('n'));
    expect(noteTitles).toEqual(Array.from({ length: 30 }, (_, i) => `n${String(29 - i).padStart(2, '0')}`));
    expect(two.next_before).toBeNull();
  });

  it('crosses a quiet stretch longer than 14 days in one request, and stops after about a year', async () => {
    await note({ title: 'Yesterday', created: '2026-11-09T12:00:00Z' });
    await note({ title: 'In August', created: '2026-08-01T12:00:00Z' });
    await note({ title: 'Long ago', created: '2024-01-01T12:00:00Z' });

    const p = await first('2026-11-10T12:00:00Z');
    expect(titles(p)).toEqual(['Yesterday']);
    expect(p.next_before).toBe('2026-11-09T00:00:00.000Z');
    const second = await page({ before: T(p.next_before!) });
    expect(titles(second)).toEqual(['In August']);
    // One request looks back at most 27 windows of 14 days and then says where to go on, even when it found nothing.
    const span = 27 * 14 * 86_400_000;
    expect(second.next_before).toBe(new Date(T('2026-11-09T00:00:00Z').getTime() - span).toISOString());
    const third = await page({ before: T(second.next_before!) });
    expect(third.days).toEqual([]);
    expect(third.next_before).toBe(new Date(T(second.next_before!).getTime() - span).toISOString());
    const fourth = await page({ before: T(third.next_before!) });
    expect(titles(fourth)).toEqual(['Long ago']);
    expect(fourth.next_before).toBeNull();
  });

  it('obeys the same limits under every filter', async () => {
    await seedProject(db, 'demo');
    for (let i = 0; i < 30; i++) {
      const t = minutes('2026-11-09T10:00:00Z', 10 * i);
      const n = String(i).padStart(2, '0');
      await file('demo', `docs/f${n}.md`, 'cli', t);
      await report({ title: `r${n}`, created: t });
      await thought({ title: `t${n}`, by: 'human', created: t });
      await note({ title: `n${n}`, created: t });
    }
    const name = (type: ActivityType, i: number) => {
      const n = String(i).padStart(2, '0');
      return { files: `docs/f${n}.md`, reports: `r${n}`, thoughts: `t${n}`, notes: `n${n}` }[type];
    };
    for (const type of ['files', 'reports', 'thoughts', 'notes'] as const) {
      const one = await first('2026-11-10T06:00:00Z', { type });
      expect([type, titles(one)]).toEqual([type, Array.from({ length: 25 }, (_, i) => name(type, 29 - i))]);
      const two = await page({ type, before: T(one.next_before!) });
      expect([type, titles(two)]).toEqual([type, Array.from({ length: 5 }, (_, i) => name(type, 4 - i))]);
      expect(two.next_before).toBeNull();
    }
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
    expect(await actions('thoughts')).toEqual(['Saved thought', 'Saved thought']);
    expect(await actions('notes')).toEqual(['New note']);
    expect((await page({ type: 'thoughts' })).next_before).toBeNull();
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

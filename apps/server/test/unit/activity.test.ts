import { describe, expect, it } from 'vitest';
import {
  type ActivityEvent, activityWindow, addDays, checkTimeZone, dayStart, localDate, mergeActivity, reportUpdate,
} from '../../src/domain/activity.js';

/** Ids whose references differ: tabula:00000001, tabula:00000002, … */
const ID = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
/** 08:00 UTC on 9 November 2026 plus some minutes. */
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 9, 8, 0) + minutes * 60_000);
const fileEvent = (n: number, minutes: number, o: Partial<ActivityEvent> = {}): ActivityEvent => ({
  kind: 'file', recordId: ID(n), title: `docs/${n}.md`, path: `docs/${n}.md`, project: 'demo', by: 'cli', at: at(minutes), create: false,
  action: '', ...o,
});
const rows = (events: ActivityEvent[]) => mergeActivity(events).map((r) => [r.action, r.by, r.at.slice(11, 16)]);

describe('activity days', () => {
  it('finds the start of a day in a time zone, across daylight saving changes', () => {
    expect(dayStart('2026-11-09', 'UTC').toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(dayStart('2026-11-09', 'Europe/Bratislava').toISOString()).toBe('2026-11-08T23:00:00.000Z');
    expect(dayStart('2026-03-29', 'Europe/Bratislava').toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(dayStart('2026-03-30', 'Europe/Bratislava').toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(dayStart('2026-10-25', 'Europe/Bratislava').toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(dayStart('2026-10-26', 'Europe/Bratislava').toISOString()).toBe('2026-10-25T23:00:00.000Z');
    // Midnight does not exist there on that day: the day starts at 01:00.
    expect(dayStart('2026-09-06', 'America/Santiago').toISOString()).toBe('2026-09-06T04:00:00.000Z');
    // The first hour repeats there on that day (01:00 back to 00:00): the day starts at the first midnight.
    expect(dayStart('2021-10-29', 'Asia/Amman').toISOString()).toBe('2021-10-28T21:00:00.000Z');
    expect(localDate(new Date('2026-11-08T23:30:00Z'), 'Europe/Bratislava')).toBe('2026-11-09');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('covers 14 days: the day of the end and the 13 before it', () => {
    expect(activityWindow(new Date('2026-11-09T10:00:00Z'), 'UTC')).toEqual({
      from: new Date('2026-10-27T00:00:00Z'), to: new Date('2026-11-09T10:00:00Z'),
    });
    // An end at midnight belongs to the day before it.
    expect(activityWindow(new Date('2026-10-27T00:00:00Z'), 'UTC').from.toISOString()).toBe('2026-10-13T00:00:00.000Z');
  });

  it('refuses a time zone it does not know', () => {
    expect(checkTimeZone('Europe/Bratislava')).toBe('Europe/Bratislava');
    expect(() => checkTimeZone('Mars/Base')).toThrow('tz "Mars/Base" is not a time zone name such as Europe/Bratislava');
  });
});

describe('activity rows', () => {
  it('makes one row of file versions whose neighbours are at most 5 minutes apart', () => {
    expect(rows([fileEvent(1, 0), fileEvent(2, 5), fileEvent(3, 10), fileEvent(4, 15 + 1 / 60)])).toEqual([
      ['Pushed 1 file', 'cli', '08:15'],
      ['Pushed 3 files', 'cli', '08:10'],
    ]);
  });

  it('keeps projects and authors apart', () => {
    expect(rows([fileEvent(1, 0), fileEvent(2, 1, { project: 'shop' }), fileEvent(3, 2, { by: 'human' }), fileEvent(4, 3)])).toEqual([
      ['Pushed 2 files', 'cli', '08:03'],
      ['Edited 1 file', 'human', '08:02'],
      ['Pushed 1 file', 'cli', '08:01'],
    ]);
  });

  it('counts a file changed twice once and lists the files newest first', () => {
    const [batch] = mergeActivity([fileEvent(1, 0), fileEvent(2, 1), fileEvent(1, 2)]);
    expect(batch).toEqual({
      type: 'file', action: 'Pushed 2 files', ref: 'tabula:00000001', id: ID(1), title: 'docs/1.md and 1 more', project: 'demo', by: 'cli',
      at: '2026-11-09T08:02:00.000Z', count: 2,
      children: [{ id: ID(1), path: 'docs/1.md', ref: 'tabula:00000001' }, { id: ID(2), path: 'docs/2.md', ref: 'tabula:00000002' }],
    });
    expect(mergeActivity([fileEvent(7, 0, { by: 'claude-code' })])).toEqual([
      {
        type: 'file', action: 'Edited 1 file', ref: 'tabula:00000007', id: ID(7), title: 'docs/7.md', path: 'docs/7.md', project: 'demo',
        by: 'claude-code', at: '2026-11-09T08:00:00.000Z',
      },
    ]);
  });

  it('merges the changes of one record by one author within an hour of the first', () => {
    const note = (minutes: number, by = 'human'): ActivityEvent => ({
      kind: 'note', recordId: ID(1), title: 'Note', project: null, by, at: at(minutes), create: false, action: 'Edited note',
    });
    expect(rows([note(0), note(30), note(60), note(61), note(20, 'claude-code')])).toEqual([
      ['Edited note', 'human', '09:01'],
      ['Edited note', 'human', '09:00'],
      ['Edited note', 'claude-code', '08:20'],
    ]);
  });

  it('keeps the creating label when a record was created and changed within the hour', () => {
    const change = (minutes: number, create: boolean, action: string): ActivityEvent => ({
      kind: 'report', recordId: ID(2), title: 'Bug', project: 'demo', by: 'human', at: at(minutes), create, action,
    });
    expect(mergeActivity([change(0, true, 'New report'), change(20, false, 'Edited')])).toEqual([
      { type: 'report', action: 'New report', ref: 'tabula:00000002', id: ID(2), title: 'Bug', project: 'demo', by: 'human', at: '2026-11-09T08:20:00.000Z' },
    ]);
  });

  it('tells what the last change of a report was from its row', () => {
    const base = { status: 'new' as const, hasTriage: false, editedBy: 'human', updatedAt: at(60), closedAt: null, uploadBy: null };
    expect(reportUpdate(base)).toEqual({ action: 'Edited', by: 'human' });
    expect(reportUpdate({ ...base, status: 'triaged', hasTriage: true, editedBy: 'claude-code' })).toEqual({ action: 'Triage written', by: 'claude-code' });
    expect(reportUpdate({ ...base, editedBy: 'claude-code' })).toEqual({ action: 'Updated', by: 'claude-code' });
    expect(reportUpdate({ ...base, status: 'done', closedAt: at(60) })).toEqual({ action: 'Closed', by: 'human' });
    // Closed long before this change: the change was something else.
    expect(reportUpdate({ ...base, status: 'done', closedAt: at(0), hasTriage: true, editedBy: 'claude-code' })).toEqual({
      action: 'Triage written', by: 'claude-code',
    });
    // An upload bumps updated_at but not edited_by: the uploader made the change.
    expect(reportUpdate({ ...base, hasTriage: true, editedBy: 'claude-code', uploadBy: 'human' })).toEqual({ action: 'Updated', by: 'human' });
  });
});

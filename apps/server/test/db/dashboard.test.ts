import { randomUUID } from 'node:crypto';
import { refOf } from '@tabula/shared/refs';
import { describe, expect, it } from 'vitest';
import { reportAttachments, reportJobs, reports, reportTranscripts } from '../../src/db/schema.js';
import { dashboard, LARGE_FILE_BYTES } from '../../src/domain/dashboard.js';
import { deleteFile, putFile, setStatePaths } from '../../src/domain/files.js';
import { recallDigests } from '../../src/domain/recall.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
/** A moment `hours` before the real now: the dashboard compares with the real clock. */
const ago = (hours: number) => new Date(Date.now() - hours * 3600_000);

async function report(o: {
  title: string; project?: string | null; status?: 'new' | 'triaged' | 'done'; created: Date; updated?: Date; version?: number; keepMedia?: boolean;
}) {
  const [r] = await db
    .insert(reports)
    .values({
      projectId: o.project === undefined ? 'demo' : o.project, title: o.title, status: o.status ?? 'new', source: 'human', editedBy: 'human',
      version: o.version ?? 1, keepMedia: o.keepMedia ?? false, createdAt: o.created, updatedAt: o.updated ?? o.created,
      closedAt: o.status === 'done' ? (o.updated ?? o.created) : null,
    })
    .returning();
  return r!;
}

type JobState = { status: 'queued' | 'running' | 'done' | 'failed'; runAfter?: Date; finishedAt?: Date; error?: string };

/** A voice note of a report, with its transcription job and its transcript as asked. */
async function recording(reportId: string, o: { job?: JobState; transcribed?: boolean; purged?: boolean } = {}) {
  const id = randomUUID();
  await db.insert(reportAttachments).values({
    id, reportId, kind: 'audio', mime: 'audio/wav', size: 10, sha256: 'x', fileName: 'voice.wav', storageKey: `${reportId}/${id}.wav`,
    createdBy: 'human', purgedAt: o.purged ? new Date() : null,
  });
  if (o.job) {
    await db.insert(reportJobs).values({
      attachmentId: id, status: o.job.status, runAfter: o.job.runAfter ?? new Date(), finishedAt: o.job.finishedAt ?? null, error: o.job.error ?? null,
    });
  }
  if (o.transcribed) await db.insert(reportTranscripts).values({ attachmentId: id, model: 'large-v3', text: 'Ahoj', segments: [] });
  return id;
}

describe('dashboard: waiting for you', () => {
  it('lists new and triaged reports and failed transcriptions of open reports, oldest first', async () => {
    await seedProject(db, 'demo');
    const freshAt = ago(2);
    const failedAt = ago(1);
    const meetingAt = ago(72);
    const triagedAt = ago(30);
    const fresh = await report({ title: 'Fresh bug', created: freshAt });
    const meeting = await report({ title: 'Weekly planning', project: null, created: meetingAt });
    const triaged = await report({ title: 'Player freezes', status: 'triaged', created: ago(100), updated: triagedAt, version: 2 });
    const failed = await recording(fresh.id, { job: { status: 'failed', finishedAt: failedAt, error: 'ffmpeg exited with 1' } });

    const d = await dashboard(db);
    expect(d.waiting.map((w) => [w.type, w.title])).toEqual([
      ['new_report', 'Weekly planning'],
      ['triaged', 'Player freezes'],
      ['new_report', 'Fresh bug'],
      ['transcription_failed', 'Fresh bug'],
    ]);
    expect(d.waiting[0]).toMatchObject({ id: meeting.id, ref: refOf(meeting.id), project: null, since: meetingAt.toISOString(), version: 1, transcript: null });
    expect(d.waiting[1]).toMatchObject({ id: triaged.id, project: 'demo', since: triagedAt.toISOString(), version: 2 });
    expect(d.waiting[2]).toMatchObject({ id: fresh.id, since: freshAt.toISOString(), transcript: 'failed', recordings: 1 });
    expect(d.waiting[3]).toMatchObject({
      id: fresh.id, ref: refOf(fresh.id), attachment_id: failed, file_name: 'voice.wav', error: 'ffmpeg exited with 1', since: failedAt.toISOString(),
    });
  });

  it('shows the strongest transcript state across the recordings: running, queued, failed, done', async () => {
    await seedProject(db, 'demo');
    const mixedRunning = await report({ title: 'Running and queued', created: ago(9) });
    await recording(mixedRunning.id, { job: { status: 'queued' } });
    await recording(mixedRunning.id, { job: { status: 'running' } });
    const mixedFailed = await report({ title: 'Failed and done', created: ago(8) });
    await recording(mixedFailed.id, { job: { status: 'done' }, transcribed: true });
    await recording(mixedFailed.id, { job: { status: 'failed', finishedAt: ago(1) } });
    const queuedFailed = await report({ title: 'Queued and failed', created: ago(7) });
    await recording(queuedFailed.id, { job: { status: 'failed', finishedAt: ago(1) } });
    await recording(queuedFailed.id, { job: { status: 'queued' } });

    const by = Object.fromEntries((await dashboard(db)).waiting.filter((w) => w.type === 'new_report').map((w) => [w.title, w]));
    expect(by['Running and queued']).toMatchObject({ transcript: 'running', recordings: 2 });
    expect(by['Failed and done']).toMatchObject({ transcript: 'failed', recordings: 2 });
    expect(by['Queued and failed']).toMatchObject({ transcript: 'queued', recordings: 2 });
  });

  it('leaves out closed reports, and failed transcriptions of closed reports or deleted recordings', async () => {
    await seedProject(db, 'demo');
    const closed = await report({ title: 'Closed one', status: 'done', created: ago(50), updated: ago(10), version: 2 });
    await recording(closed.id, { job: { status: 'failed', finishedAt: ago(5) } });
    const open = await report({ title: 'Open one', created: ago(5) });
    await recording(open.id, { job: { status: 'failed', finishedAt: ago(4) }, purged: true });

    const d = await dashboard(db);
    expect(d.waiting.map((w) => [w.type, w.title])).toEqual([['new_report', 'Open one']]);
  });

  it('tells how the recordings of a new report stand and counts those on disk, with Keep media', async () => {
    await seedProject(db, 'demo');
    const done = await report({ title: 'Done', created: ago(9) });
    await recording(done.id, { job: { status: 'done' }, transcribed: true });
    const waiting = await report({ title: 'Waiting', created: ago(8), keepMedia: true });
    await recording(waiting.id, { job: { status: 'queued' } });
    await recording(waiting.id, { job: { status: 'done' }, transcribed: true });
    const running = await report({ title: 'Running', created: ago(7) });
    await recording(running.id, { job: { status: 'running' } });
    await report({ title: 'Text only', created: ago(6) });

    const by = Object.fromEntries((await dashboard(db)).waiting.map((w) => [w.title, w]));
    expect(by.Done).toMatchObject({ transcript: 'done', recordings: 1, keep_media: false });
    expect(by.Waiting).toMatchObject({ transcript: 'queued', recordings: 2, keep_media: true });
    expect(by.Running).toMatchObject({ transcript: 'running', recordings: 1 });
    expect(by['Text only']).toMatchObject({ transcript: null, recordings: 0 });
  });

  it('does not count a purged recording in a report', async () => {
    await seedProject(db, 'demo');
    const r = await report({ title: 'Reopened', created: ago(60) });
    await recording(r.id, { job: { status: 'done' }, transcribed: true, purged: true });
    await recording(r.id, { job: { status: 'done' }, transcribed: true });
    expect((await dashboard(db)).waiting).toEqual([expect.objectContaining({ title: 'Reopened', recordings: 1 })]);
  });

  it('does not call a report failed because of a purged recording', async () => {
    await seedProject(db, 'demo');
    const r = await report({ title: 'Reopened', created: ago(60) });
    await recording(r.id, { job: { status: 'failed', finishedAt: ago(5) }, purged: true });
    await recording(r.id, { job: { status: 'done' }, transcribed: true });
    expect((await dashboard(db)).waiting).toEqual([expect.objectContaining({ type: 'new_report', transcript: 'done' })]);
  });
});

describe('dashboard: warnings', () => {
  it('warns about a recall that had to be trimmed, with its steps, and not about one that fits', async () => {
    await seedProject(db, 'alpha');
    await seedProject(db, 'beta');
    const state = Array.from({ length: 600 }, (_, i) => `- Step ${i}: something that happened in this session.`).join('\n');
    await putFile(db, 'alpha', { path: 'docs/handoff/state.md', content: state, baseSha256: null }, 'cli');
    await setStatePaths(db, 'alpha', ['docs/handoff/state.md']);
    await putFile(db, 'beta', { path: 'docs/plan.md', content: 'Plan', baseSha256: null }, 'cli');

    const d = await dashboard(db);
    const alpha = (await recallDigests(db, ['alpha'])).get('alpha')!;
    expect(d.warnings.filter((w) => w.type === 'recall_trimmed')).toEqual([
      { type: 'recall_trimmed', project: 'alpha', steps: ['state-truncated'], tokens: alpha.tokens },
    ]);
  });

  it('warns about a file just over half the file limit, not one at it or just under it, and not a deleted one', async () => {
    await seedProject(db, 'demo');
    const put = (path: string, bytes: number) => putFile(db, 'demo', { path, content: 'a'.repeat(bytes), baseSha256: null }, 'cli');
    await put('logs/over.txt', LARGE_FILE_BYTES + 1);
    await put('logs/at.txt', LARGE_FILE_BYTES);
    await put('logs/under.txt', LARGE_FILE_BYTES - 1);
    await put('logs/gone.txt', LARGE_FILE_BYTES + 10);
    await deleteFile(db, 'demo', 'logs/gone.txt');

    const d = await dashboard(db);
    expect(d.warnings.filter((w) => w.type === 'large_file')).toEqual([
      {
        type: 'large_file', project: 'demo', id: expect.any(String), ref: expect.stringMatching(/^tabula:[0-9a-f]{8}$/), path: 'logs/over.txt',
        size: LARGE_FILE_BYTES + 1, limit: 1_048_576,
      },
    ]);
  });

  it('warns about recordings that have waited for the worker more than 24 hours', async () => {
    await seedProject(db, 'demo');
    const r = await report({ title: 'Meeting', created: ago(40) });
    await recording(r.id, { job: { status: 'queued', runAfter: ago(23) } });
    expect((await dashboard(db)).warnings.filter((w) => w.type === 'recordings_waiting')).toEqual([]);

    const oldest = ago(30);
    await recording(r.id, { job: { status: 'queued', runAfter: ago(25) } });
    await recording(r.id, { job: { status: 'queued', runAfter: oldest } });
    expect((await dashboard(db)).warnings.filter((w) => w.type === 'recordings_waiting')).toEqual([
      { type: 'recordings_waiting', project: null, count: 2, oldest: oldest.toISOString() },
    ]);
  });

  it('has no recordings warning on a server without a worker, and says so', async () => {
    await seedProject(db, 'demo');
    const r = await report({ title: 'Meeting', created: ago(60) });
    await recording(r.id, { job: { status: 'queued', runAfter: ago(25) } });
    const off = await dashboard(db, new Date(), { workerEnabled: false });
    expect(off.warnings.filter((w) => w.type === 'recordings_waiting')).toEqual([]);
    expect(off.transcription_enabled).toBe(false);
    const on = await dashboard(db);
    expect(on.warnings.filter((w) => w.type === 'recordings_waiting')).toHaveLength(1);
    expect(on.transcription_enabled).toBe(true);
  });

  it('does not warn about a large file of global: the web has no file view for it', async () => {
    await putFile(db, 'global', { path: 'rules/big.md', content: 'a'.repeat(LARGE_FILE_BYTES + 1), baseSha256: null }, 'cli');
    expect((await dashboard(db)).warnings.filter((w) => w.type === 'large_file')).toEqual([]);
  });

  it('does not warn about a purged recording that waited more than 24 hours: the worker skips it', async () => {
    await seedProject(db, 'demo');
    const r = await report({ title: 'Meeting', created: ago(60) });
    await recording(r.id, { job: { status: 'queued', runAfter: ago(40) }, purged: true });
    expect((await dashboard(db)).warnings.filter((x) => x.type === 'recordings_waiting')).toEqual([]);
  });
});

describe('dashboard: projects', () => {
  it('lists the projects by activity with file and open report counts and the recall estimate, without global', async () => {
    await seedProject(db, 'alpha');
    await seedProject(db, 'beta');
    await report({ title: 'Open', project: 'beta', created: ago(48) });
    await report({ title: 'Triaged', project: 'beta', status: 'triaged', created: ago(49) });
    await report({ title: 'Closed', project: 'beta', status: 'done', created: ago(50) });
    await putFile(db, 'beta', { path: 'docs/a.md', content: 'A', baseSha256: null }, 'cli');
    await putFile(db, 'alpha', { path: 'docs/b.md', content: 'B', baseSha256: null }, 'cli');
    await putFile(db, 'alpha', { path: 'docs/c.md', content: 'C', baseSha256: null }, 'cli');

    const d = await dashboard(db);
    expect(d.projects.map((p) => p.id)).toEqual(['alpha', 'beta']);
    expect(d.projects[0]).toMatchObject({ name: 'alpha', file_count: 2, open_reports: 0 });
    expect(d.projects[1]).toMatchObject({ name: 'beta', file_count: 1, open_reports: 2 });
    expect(d.projects[0]!.last_activity_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const digests = await recallDigests(db, ['alpha', 'beta']);
    expect(d.projects.map((p) => p.recall_tokens)).toEqual([digests.get('alpha')!.tokens, digests.get('beta')!.tokens]);
    expect(d.recall_budget).toBe(3000);
  });
});

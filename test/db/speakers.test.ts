import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { reportAttachments, reportJobs, reports, reportTranscripts } from '../../src/db/schema.js';
import {
  claimJob, completeJob, enqueueTranscription, transcribeAgain, type TranscriptInput, transcriptStates,
} from '../../src/domain/jobs.js';
import { nameSpeakersAsAgent, setSpeakerNames, speakerNameSuggestions } from '../../src/domain/speakers.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
beforeEach(async () => {
  await seedProject(db, 'demo');
  await seedProject(db, 'other');
});

const SEGMENTS = [
  { start_ms: 0, end_ms: 900, text: 'Kde je tlačidlo?', speaker: 'S1' },
  { start_ms: 1000, end_ms: 1900, text: 'Vpravo hore.', speaker: 'S2' },
];
const PYANNOTE = { model: 'pyannote/speaker-diarization-community-1', speakers: 2 };

/** A report with one voice note, queued and transcribed by a worker with speakers. */
async function transcribed(project = 'demo') {
  const [r] = await db.insert(reports).values({ projectId: project, title: 'Login loops', source: 'human', editedBy: 'human' }).returning();
  const id = randomUUID();
  await db.insert(reportAttachments).values({
    id, reportId: r!.id, kind: 'audio', mime: 'audio/wav', size: 10, sha256: 'x', fileName: 'voice.wav', storageKey: `${r!.id}/${id}.wav`, createdBy: 'human',
  });
  await enqueueTranscription(db, id);
  await finish({ segments: SEGMENTS, diarization: PYANNOTE });
  return { reportId: r!.id, attachmentId: id };
}

/** The worker takes the next job and hands in a transcript. */
async function finish(t: Pick<TranscriptInput, 'segments' | 'diarization'>) {
  const claimed = (await claimJob(db, 'pc'))!;
  await completeJob(db, claimed.job.id, claimed.job.leaseId!, { language: 'sk', model: 'large-v3', durationMs: 2000, ...t });
}

const stateOf = async (id: string) => (await transcriptStates(db, [id])).get(id)!;

describe('speakers', () => {
  it('stores the speakers and the diarization with the transcript', async () => {
    const { attachmentId } = await transcribed();
    expect(await stateOf(attachmentId)).toMatchObject({ status: 'done', segments: SEGMENTS, diarization: PYANNOTE, speakers: {}, again: null });
    const [t] = await db.select().from(reportTranscripts);
    expect(t!.text).toBe('Kde je tlačidlo?\nVpravo hore.');
  });

  it("sets, confirms and clears the user's names; unknown speakers and missing transcripts are refused", async () => {
    const { attachmentId } = await transcribed();
    const now = new Date('2026-11-08T10:00:00.000Z');
    expect(await setSpeakerNames(db, attachmentId, { S1: 'Eva', S2: 'Tomáš' }, now)).toEqual({
      S1: { name: 'Eva', by: 'user', at: now.toISOString() }, S2: { name: 'Tomáš', by: 'user', at: now.toISOString() },
    });
    expect(await setSpeakerNames(db, attachmentId, { S2: '' })).toEqual({ S1: expect.objectContaining({ name: 'Eva' }) });
    await expect(setSpeakerNames(db, attachmentId, { S3: 'Peter' })).rejects.toThrow(/unknown speaker S3/);
    await expect(setSpeakerNames(db, randomUUID(), { S1: 'Peter' })).rejects.toThrow(/has no transcript yet/);
  });

  it("writes an agent's names where it may and says what it skipped", async () => {
    const { attachmentId } = await transcribed();
    await setSpeakerNames(db, attachmentId, { S1: 'Eva' });
    const r = await nameSpeakersAsAgent(db, attachmentId, { S1: 'Marek', S2: 'Tomáš' });
    expect(r.written).toEqual({ S2: 'Tomáš' });
    expect(r.skipped).toEqual([{ speaker: 'S1', reason: 'the user named S1 "Eva"; a name from the user is never replaced' }]);
    expect(await stateOf(attachmentId)).toMatchObject({ speakers: { S1: { name: 'Eva', by: 'user' }, S2: { name: 'Tomáš', by: 'agent' } } });
  });

  it("lets an agent's name replace an earlier agent's, and refuses an empty name without writing anything", async () => {
    const { attachmentId } = await transcribed();
    await nameSpeakersAsAgent(db, attachmentId, { S1: 'Marek' }, new Date('2026-11-08T09:00:00.000Z'));
    const later = new Date('2026-11-08T10:00:00.000Z');
    const r = await nameSpeakersAsAgent(db, attachmentId, { S1: 'Eva' }, later);
    expect(r.written).toEqual({ S1: 'Eva' });
    expect(r.skipped).toEqual([]);
    expect(await stateOf(attachmentId)).toMatchObject({ speakers: { S1: { name: 'Eva', by: 'agent', at: later.toISOString() } } });

    await expect(nameSpeakersAsAgent(db, attachmentId, { S2: 'Tomáš', S1: '  ' })).rejects.toThrow(/the name of S1 is empty/);
    const after = await stateOf(attachmentId);
    expect(after).toMatchObject({ speakers: { S1: { name: 'Eva' } } });
    expect(Object.keys((after as { speakers: object }).speakers)).toEqual(['S1']);
  });

  it("suggests the report's names, then the project's, never another project's", async () => {
    const here = await transcribed();
    const elsewhere = await transcribed();
    const foreign = await transcribed('other');
    await setSpeakerNames(db, elsewhere.attachmentId, { S1: 'Peter' }, new Date('2026-11-08T12:00:00.000Z'));
    await setSpeakerNames(db, here.attachmentId, { S1: 'Eva' }, new Date('2026-11-08T09:00:00.000Z'));
    await setSpeakerNames(db, foreign.attachmentId, { S1: 'Cudzí' });
    expect(await speakerNameSuggestions(db, here.reportId)).toEqual(['Eva', 'Peter']);
    await expect(speakerNameSuggestions(db, randomUUID())).rejects.toThrow(/does not exist/);
  });

  it('transcribes a recording again: only when nothing runs, the report is open and the recording exists; the new transcript clears the names', async () => {
    const { attachmentId, reportId } = await transcribed();
    await setSpeakerNames(db, attachmentId, { S1: 'Eva' });
    const job = await transcribeAgain(db, attachmentId);
    expect(job).toMatchObject({ status: 'queued', attempts: 0, error: null, leaseId: null });
    expect(await stateOf(attachmentId)).toMatchObject({ status: 'done', speakers: { S1: { name: 'Eva' } }, again: { status: 'queued', error: null } });
    await expect(transcribeAgain(db, attachmentId)).rejects.toThrow(/already waiting for the worker or being transcribed/);

    // A worker takes the job: it runs, and is refused just the same.
    const claimed = (await claimJob(db, 'pc'))!;
    expect(await stateOf(attachmentId)).toMatchObject({ status: 'done', again: { status: 'running' } });
    await expect(transcribeAgain(db, attachmentId)).rejects.toThrow(/already waiting for the worker or being transcribed/);
    await completeJob(db, claimed.job.id, claimed.job.leaseId!, {
      language: 'sk', model: 'large-v3', durationMs: 2000,
      segments: [{ ...SEGMENTS[0]!, speaker: 'S2' }, { ...SEGMENTS[1]!, speaker: 'S1' }], diarization: PYANNOTE,
    });
    expect(await stateOf(attachmentId)).toMatchObject({ status: 'done', speakers: {}, again: null, segments: [{ speaker: 'S2' }, { speaker: 'S1' }] });

    await db.update(reports).set({ status: 'done', closedAt: new Date() }).where(eq(reports.id, reportId));
    await expect(transcribeAgain(db, attachmentId)).rejects.toThrow(/the report is closed/);
    await db.update(reports).set({ status: 'new', closedAt: null }).where(eq(reports.id, reportId));
    await db.update(reportAttachments).set({ purgedAt: new Date() }).where(eq(reportAttachments.id, attachmentId));
    await expect(transcribeAgain(db, attachmentId)).rejects.toThrow(/deleted after the report was closed/);
    await expect(transcribeAgain(db, randomUUID())).rejects.toThrow(/does not exist/);
  });

  it("a re-run of one recording leaves another recording's names alone", async () => {
    const a = await transcribed();
    const b = await transcribed();
    await setSpeakerNames(db, a.attachmentId, { S1: 'Eva' });
    await setSpeakerNames(db, b.attachmentId, { S1: 'Peter', S2: 'Tomáš' });
    await transcribeAgain(db, a.attachmentId);
    await finish({ segments: SEGMENTS, diarization: PYANNOTE });
    expect(await stateOf(a.attachmentId)).toMatchObject({ speakers: {}, again: null });
    expect(await stateOf(b.attachmentId)).toMatchObject({ speakers: { S1: { name: 'Peter' }, S2: { name: 'Tomáš' } } });
  });

  it('keeps the old transcript when transcribing again fails, and says so', async () => {
    const { attachmentId } = await transcribed();
    await transcribeAgain(db, attachmentId);
    await db.update(reportJobs).set({ status: 'failed', error: 'CUDA is not available' }).where(eq(reportJobs.attachmentId, attachmentId));
    expect(await stateOf(attachmentId)).toMatchObject({ status: 'done', segments: SEGMENTS, again: { status: 'failed', error: 'CUDA is not available' } });
  });
});

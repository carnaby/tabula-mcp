import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Diarization, reportAttachments, reports, type TranscriptSegment } from '../../src/db/schema.js';
import { claimJob, completeJob, enqueueTranscription, transcribeAgain, transcriptStates } from '../../src/domain/jobs.js';
import { pageReports } from '../../src/domain/reports.js';
import { editSegmentAsUser, editTranscriptAsAgent, restoreSegment, SegmentChangedError } from '../../src/domain/transcript-edits.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
beforeEach(() => seedProject(db, 'demo'));

const SEGMENTS: TranscriptSegment[] = [
  { start_ms: 0, end_ms: 900, text: 'Ako sa má Tabla?', speaker: 'S1' },
  { start_ms: 1000, end_ms: 1900, text: 'Dobre, prepis beží.', speaker: 'S2' },
];
const PYANNOTE: Diarization = { model: 'pyannote/speaker-diarization-community-1', speakers: 2 };
const NOW = new Date('2026-11-09T10:00:00.000Z');
const FIRST = { text: 'Ako sa má Tabla?', speaker: 'S1' };

/** The worker takes the next job and hands in a transcript. */
async function finish(segments = SEGMENTS, diarization: Diarization | null = PYANNOTE) {
  const c = (await claimJob(db, 'pc'))!;
  await completeJob(db, c.job.id, c.job.leaseId!, { language: 'sk', model: 'large-v3', durationMs: 2000, segments, diarization });
}

/** A report with one transcribed voice note. */
async function transcribed(segments = SEGMENTS, diarization: Diarization | null = PYANNOTE) {
  const [r] = await db.insert(reports).values({ projectId: 'demo', title: 'Meeting', source: 'human', editedBy: 'human' }).returning();
  const id = randomUUID();
  await db.insert(reportAttachments).values({
    id, reportId: r!.id, kind: 'audio', mime: 'audio/wav', size: 10, sha256: 'x', fileName: 'voice.wav', storageKey: `${r!.id}/${id}.wav`, createdBy: 'human',
  });
  await enqueueTranscription(db, id);
  await finish(segments, diarization);
  return id;
}

async function linesOf(id: string): Promise<TranscriptSegment[]> {
  const s = (await transcriptStates(db, [id])).get(id)!;
  if (s.status !== 'done') throw new Error(`no transcript: ${s.status}`);
  return s.segments;
}
const searchFinds = async (q: string) => (await pageReports(db, { q, status: 'all' })).total;

describe("the user's line edits", () => {
  it('changes the text and the speaker, keeps the original from the first edit, and search follows', async () => {
    const id = await transcribed();
    await editSegmentAsUser(db, id, 0, { text: '  Ako sa má   Tabula? ', expected: FIRST }, NOW);
    expect((await linesOf(id))[0]).toEqual({
      start_ms: 0, end_ms: 900, text: 'Ako sa má Tabula?', speaker: 'S1', edit: { by: 'user', at: NOW.toISOString(), original: FIRST },
    });
    await editSegmentAsUser(db, id, 0, { speaker: 'S2', expected: { text: 'Ako sa má Tabula?', speaker: 'S1' } }, NOW);
    expect((await linesOf(id))[0]).toMatchObject({ text: 'Ako sa má Tabula?', speaker: 'S2', edit: { by: 'user', original: FIRST } });
    expect(await searchFinds('tabula')).toBe(1);
    expect(await searchFinds('tabla')).toBe(0);
  });

  it('refuses an empty or too long text, an unknown speaker, an empty change, a missing line and a missing transcript', async () => {
    const id = await transcribed();
    await expect(editSegmentAsUser(db, id, 0, { text: '   ', expected: FIRST })).rejects.toThrow(/text is empty/);
    await expect(editSegmentAsUser(db, id, 0, { text: 'a'.repeat(2001), expected: FIRST })).rejects.toThrow(/2001 characters; the limit is 2000/);
    await expect(editSegmentAsUser(db, id, 0, { speaker: 'S3', expected: FIRST })).rejects.toThrow(/unknown speaker S3; the recording has S1, S2/);
    await expect(editSegmentAsUser(db, id, 0, { expected: FIRST })).rejects.toThrow(/pass text or speaker/);
    await expect(editSegmentAsUser(db, id, 2, { text: 'x', expected: FIRST })).rejects.toThrow(/has no line 2 \(it has 2\)/);
    await expect(editSegmentAsUser(db, randomUUID(), 0, { text: 'x', expected: FIRST })).rejects.toThrow(/has no transcript yet/);
    expect((await linesOf(id))[0]).not.toHaveProperty('edit');
  });

  it('refuses any speaker on a recording without speaker recognition', async () => {
    const id = await transcribed([{ start_ms: 0, end_ms: 900, text: 'Ahoj.' }], null);
    await expect(editSegmentAsUser(db, id, 0, { speaker: 'S1', expected: { text: 'Ahoj.' } })).rejects.toThrow(/the recording has no speakers/);
    await editSegmentAsUser(db, id, 0, { text: 'Ahoj!', expected: { text: 'Ahoj.', speaker: null } });
    expect((await linesOf(id))[0]).toMatchObject({ text: 'Ahoj!', edit: { original: { text: 'Ahoj.' } } });
  });

  it('answers a line Claude changed meanwhile with the current one and writes nothing', async () => {
    const id = await transcribed();
    await editTranscriptAsAgent(db, id, [{ at: '0:00', from: 'Tabla', to: 'Tabula' }], NOW);
    const stale = editSegmentAsUser(db, id, 0, { text: 'Ako sa má Tablo?', expected: FIRST });
    await expect(stale).rejects.toBeInstanceOf(SegmentChangedError);
    const e = (await stale.catch((x: unknown) => x)) as SegmentChangedError;
    expect(e.status).toBe(409);
    expect(e.current).toMatchObject({ text: 'Ako sa má Tabula?', edit: { by: 'agent' } });
    expect((await linesOf(id))[0]!.text).toBe('Ako sa má Tabula?');
  });

  it('answers 409 when a new transcript replaced the line while the user typed', async () => {
    const id = await transcribed();
    await transcribeAgain(db, id);
    await finish([{ start_ms: 0, end_ms: 900, text: 'Ako sa má Tabula?', speaker: 'S2' }, SEGMENTS[1]!]);
    await expect(editSegmentAsUser(db, id, 0, { text: 'Ako sa má Tabula?!', expected: FIRST })).rejects.toBeInstanceOf(SegmentChangedError);
    expect((await linesOf(id))[0]).toEqual({ start_ms: 0, end_ms: 900, text: 'Ako sa má Tabula?', speaker: 'S2' });
  });

  it("makes Claude's line the user's when saved unchanged, and restores the original", async () => {
    const id = await transcribed();
    await editTranscriptAsAgent(db, id, [{ at: '0:00', from: 'Tabla', to: 'Tabula', speaker: 'S2' }], NOW);
    await editSegmentAsUser(db, id, 0, { text: 'Ako sa má Tabula?', expected: { text: 'Ako sa má Tabula?', speaker: 'S2' } }, NOW);
    expect((await linesOf(id))[0]).toMatchObject({ edit: { by: 'user', original: FIRST } });
    await restoreSegment(db, id, 0);
    expect((await linesOf(id))[0]).toEqual(SEGMENTS[0]);
    await restoreSegment(db, id, 1); // an unedited line stays as it is
    expect((await linesOf(id))[1]).toEqual(SEGMENTS[1]);
    await expect(restoreSegment(db, id, 5)).rejects.toThrow(/has no line 5/);
    expect(await searchFinds('tabla')).toBe(1);
  });

  it('writes nothing when an unedited line is saved unchanged', async () => {
    const id = await transcribed();
    await editSegmentAsUser(db, id, 1, { text: 'Dobre, prepis beží.', speaker: 'S2', expected: { text: 'Dobre, prepis beží.', speaker: 'S2' } });
    expect((await linesOf(id))[1]).not.toHaveProperty('edit');
  });

  it('a new transcript replaces the lines with their edits', async () => {
    const id = await transcribed();
    await editSegmentAsUser(db, id, 0, { text: 'Ako sa má Tabula?', expected: FIRST });
    await transcribeAgain(db, id);
    await finish();
    expect(await linesOf(id)).toEqual(SEGMENTS);
  });
});

describe('while the recording is transcribed again', () => {
  it('refuses the new edits of the user, skips every edit of Claude, and writes nothing', async () => {
    const id = await transcribed();
    await transcribeAgain(db, id);
    await expect(editSegmentAsUser(db, id, 0, { text: 'Ako sa má Tabula?', expected: FIRST })).rejects.toMatchObject({
      status: 409, message: expect.stringMatching(/being transcribed again/),
    });
    await expect(restoreSegment(db, id, 0)).rejects.toMatchObject({ status: 409 });
    const r = await editTranscriptAsAgent(db, id, [{ at: '0:00', from: 'Tabla', to: 'Tabula' }, { at: '0:01', speaker: 'S1' }], NOW);
    expect(r).toEqual({
      written: [],
      skipped: [
        { at: '0:00', reason: 'the recording is being transcribed again' },
        { at: '0:01', reason: 'the recording is being transcribed again' },
      ],
    });
    expect(await linesOf(id)).toEqual(SEGMENTS);
    // Once the new transcript is in, editing works again.
    await finish();
    await editSegmentAsUser(db, id, 0, { text: 'Ako sa má Tabula?', expected: FIRST });
    expect((await linesOf(id))[0]).toMatchObject({ text: 'Ako sa má Tabula?', edit: { by: 'user' } });
  });
});

describe("Claude's line edits", () => {
  it('skips an edit that changes nothing, and the line does not become edited', async () => {
    const id = await transcribed();
    const r = await editTranscriptAsAgent(db, id, [{ at: '0:00', from: 'Tabla', to: 'Tabla' }, { at: '0:01', speaker: 'S2' }, { at: '0:01', from: 'prepis', to: 'prepis', speaker: 'S2' }], NOW);
    expect(r).toEqual({
      written: [],
      skipped: [{ at: '0:00', reason: 'nothing to change' }, { at: '0:01', reason: 'nothing to change' }, { at: '0:01', reason: 'nothing to change' }],
    });
    expect(await linesOf(id)).toEqual(SEGMENTS);
  });

  it('writes, skips the line the user edited, and search follows', async () => {
    const id = await transcribed();
    await editSegmentAsUser(db, id, 1, { text: 'Dobre, prepis už beží.', expected: { text: 'Dobre, prepis beží.', speaker: 'S2' } });
    const r = await editTranscriptAsAgent(db, id, [
      { at: '0:00', from: 'Tabla', to: 'Tabula' },
      { at: '0:01', from: 'prepis', to: 'prepisovanie' },
      { at: '0:05', speaker: 'S1' },
    ], NOW);
    expect(r).toEqual({
      written: [{ at: '0:00', text: 'Ako sa má Tabula?' }],
      skipped: [
        { at: '0:01', reason: 'the user edited this line; a line the user edited is never changed' },
        { at: '0:05', reason: 'no line starts at 0:05' },
      ],
    });
    expect((await linesOf(id))[0]).toMatchObject({ text: 'Ako sa má Tabula?', edit: { by: 'agent', at: NOW.toISOString(), original: FIRST } });
    expect(await searchFinds('tabula')).toBe(1);
  });

  it('writes nothing for a malformed call', async () => {
    const id = await transcribed();
    await expect(editTranscriptAsAgent(db, id, Array(51).fill({ at: '0:00', speaker: 'S2' }))).rejects.toThrow(/51 edits; at most 50/);
    await expect(editTranscriptAsAgent(db, id, [{ at: '0:00', from: 'Tabla', to: 'Tabula' }, { at: 'x', speaker: 'S1' }])).rejects.toThrow(/at "x"/);
    expect(await linesOf(id)).toEqual(SEGMENTS);
  });
});

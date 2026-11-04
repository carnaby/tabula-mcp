import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reportAttachments, reports, reportTranscripts } from '../../src/db/schema.js';
import { pageReports } from '../../src/domain/reports.js';
import { quickSearch } from '../../src/domain/search.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();

async function reportWithTranscript(title: string, body: string, transcript: string) {
  const [r] = await db.insert(reports).values({ projectId: 'demo', title, body, source: 'human', editedBy: 'human' }).returning();
  const id = randomUUID();
  await db.insert(reportAttachments).values({
    id, reportId: r!.id, kind: 'audio', mime: 'audio/wav', size: 1, sha256: 'x', fileName: 'v.wav', storageKey: `${r!.id}/${id}.wav`,
    createdBy: 'human',
  });
  await db.insert(reportTranscripts).values({ attachmentId: id, language: 'sk', model: 'large-v3', text: transcript, segments: [] });
  return r!;
}

describe('transcripts in search', () => {
  it('finds a report by the words of its transcript in the report list and the quick search', async () => {
    await seedProject(db, 'demo');
    const r = await reportWithTranscript('Player bug', '', 'Tlačidlo prehrávania sa zasekne');
    expect((await pageReports(db, { q: 'prehráv' })).items.map((x) => x.id)).toEqual([r.id]);
    expect((await pageReports(db, { q: 'player' })).total).toBe(1);
    expect((await pageReports(db, { q: 'gitara' })).total).toBe(0);
    const hits = await quickSearch(db, { q: 'zasek' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: r.id, type: 'report', project: 'demo', title: 'Player bug' });
    expect(hits[0]!.snippet).toContain('**zasekne**');
  });

  it('lists a report once when both its text and its transcript match', async () => {
    await seedProject(db, 'demo');
    await reportWithTranscript('Freeze on play', 'The player freezes', 'player freezes again');
    expect((await pageReports(db, { q: 'freez' })).total).toBe(1);
    expect(await quickSearch(db, { q: 'freez' })).toHaveLength(1);
  });
});

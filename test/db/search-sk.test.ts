import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { reportAttachments, reports, reportTranscripts } from '../../src/db/schema.js';
import { putFile } from '../../src/domain/files.js';
import { createMemory, listMemories } from '../../src/domain/memories.js';
import { createNote, findNotes, pageNotes } from '../../src/domain/notes.js';
import { pageReports } from '../../src/domain/reports.js';
import { quickSearch, search } from '../../src/domain/search.js';
import { createThought, findThoughts, HUMAN } from '../../src/domain/thoughts.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const rule = (title: string, body = 'Some context here.') =>
  createMemory(db, { projectId: 'global', kind: 'rule', title, body, source: 'agent' });
const file = (path: string, content: string) => putFile(db, 'demo', { path, content, baseSha256: null }, 'cli');

async function reportWithTranscript(title: string, transcript: string) {
  const [r] = await db.insert(reports).values({ projectId: 'demo', title, body: '', source: 'human', editedBy: 'human' }).returning();
  const id = randomUUID();
  await db.insert(reportAttachments).values({
    id, reportId: r!.id, kind: 'audio', mime: 'audio/wav', size: 1, sha256: 'x', fileName: 'v.wav', storageKey: `${r!.id}/${id}.wav`,
    createdBy: 'human',
  });
  await db.insert(reportTranscripts).values({ attachmentId: id, language: 'sk', model: 'large-v3', text: transcript, segments: [] });
  return r!;
}

beforeEach(() => seedProject(db, 'demo'));

// [text stored in the record, query typed by the user]
describe.each([
  ['grafická', 'graficka'],
  ['graficka', 'grafická'],
  ['Grafická', 'GRAFICKA'],
  ['GRAFICKA', 'Grafická'],
])('search ignores diacritics and case: text %s, query %s', (stored, query) => {
  it('finds a global rule (search, rules list, quick search)', async () => {
    const m = await rule(`Používaj ${stored} kartu`);
    expect((await search(db, { query })).map((h) => h.id)).toEqual([m.id]);
    expect((await listMemories(db, { q: query })).map((x) => x.id)).toEqual([m.id]);
    expect((await quickSearch(db, { q: query })).map((h) => h.id)).toEqual([m.id]);
  });

  it('finds a note', async () => {
    const n = await createNote(db, { title: 'Návrh', body: `Nová ${stored} karta` });
    expect((await findNotes(db, { query })).map((h) => h.id)).toEqual([n.id]);
    expect((await pageNotes(db, { q: query })).items.map((x) => x.id)).toEqual([n.id]);
    expect((await quickSearch(db, { q: query })).map((h) => h.id)).toEqual([n.id]);
  });

  it('finds a thought', async () => {
    const t = await createThought(db, { title: 'Nápad', body: `Nová ${stored} karta` }, HUMAN);
    expect((await findThoughts(db, { query })).map((h) => h.id)).toEqual([t.id]);
    expect((await quickSearch(db, { q: query })).map((h) => h.id)).toEqual([t.id]);
  });

  it('finds a project file by path and by content', async () => {
    await file(`docs/${stored}-mapa/plan.md`, 'nothing to see');
    await file('docs/other.md', `Táto ${stored} mapa`);
    const byPath = await search(db, { query, project: 'demo' });
    expect(byPath.map((h) => h.path).sort()).toEqual([`docs/${stored}-mapa/plan.md`, 'docs/other.md']);
    expect((await quickSearch(db, { q: query })).map((h) => h.title).sort()).toEqual([`docs/${stored}-mapa/plan.md`, 'docs/other.md']);
  });

  it('finds a bug report by its text', async () => {
    const [r] = await db.insert(reports).values({
      projectId: 'demo', title: `Zlá ${stored} karta`, body: '', source: 'human', editedBy: 'human',
    }).returning();
    expect((await pageReports(db, { q: query })).items.map((x) => x.id)).toEqual([r!.id]);
    expect((await quickSearch(db, { q: query })).map((h) => h.id)).toEqual([r!.id]);
  });

  it('finds a bug report by its transcript', async () => {
    const r = await reportWithTranscript('Player bug', `Tu je tá ${stored} karta`);
    expect((await pageReports(db, { q: query })).items.map((x) => x.id)).toEqual([r.id]);
    expect((await quickSearch(db, { q: query })).map((h) => h.id)).toEqual([r.id]);
  });
});

describe('search keeps the original text in snippets', () => {
  it('highlights the word with its diacritics when the query has none', async () => {
    await rule('Karta', 'Používaj grafická karta pre render.');
    await createThought(db, { title: 'Nápad', body: 'Nová grafická karta' }, HUMAN);
    expect((await search(db, { query: 'graficka' }))[0]!.snippet).toContain('**grafická**');
    expect((await findThoughts(db, { query: 'graficka' }))[0]!.snippet).toContain('**grafická**');
    const quick = await quickSearch(db, { q: 'graficka' });
    expect(quick.map((h) => h.snippet).join(' ')).toContain('**grafická**');
  });
});

describe('word-prefix matching in rules and search', () => {
  it('a plain query matches the beginning of words', async () => {
    const m = await rule('Pracuj s projektom opatrne');
    await file('docs/plan.md', 'Poznámky k projektovaniu');
    expect((await search(db, { query: 'projekt' })).map((h) => h.type).sort()).toEqual(['file', 'memory']);
    expect((await listMemories(db, { q: 'projekt' })).map((x) => x.id)).toEqual([m.id]);
    // Prefix and diacritics together; every word must match.
    expect((await search(db, { query: 'poznam projekt' })).map((h) => h.path)).toEqual(['docs/plan.md']);
    expect(await search(db, { query: 'projekt gitara' })).toEqual([]);
  });

  it('a quoted phrase matches exact words in that order', async () => {
    await rule('Grafická mapa sveta');
    await rule('Mapa grafická naopak');
    await rule('Pracuj s projektom');
    expect((await search(db, { query: '"graficka mapa"' })).map((h) => h.title)).toEqual(['Grafická mapa sveta']);
    expect((await listMemories(db, { q: '"graficka mapa"' })).map((h) => h.title)).toEqual(['Grafická mapa sveta']);
    // Inside websearch syntax words match exactly again.
    expect(await search(db, { query: '"projekt"' })).toEqual([]);
  });

  it('OR matches either word', async () => {
    await rule('Alpha rule');
    await rule('Beta rule');
    await rule('Gamma rule');
    expect((await search(db, { query: 'alpha OR beta' })).map((h) => h.title).sort()).toEqual(['Alpha rule', 'Beta rule']);
    expect((await listMemories(db, { q: 'alpha OR beta' })).map((h) => h.title).sort()).toEqual(['Alpha rule', 'Beta rule']);
    // websearch_to_tsquery reads "or" in any case as OR, so the switch does too.
    expect((await search(db, { query: 'alpha or beta' })).map((h) => h.title).sort()).toEqual(['Alpha rule', 'Beta rule']);
  });

  it('-word excludes records containing it', async () => {
    await rule('Cache in memory');
    await rule('Cache in redis');
    expect((await search(db, { query: 'cache -redis' })).map((h) => h.title)).toEqual(['Cache in memory']);
    expect((await listMemories(db, { q: 'cache -redis' })).map((h) => h.title)).toEqual(['Cache in memory']);
    // A hyphen inside a word is not an exclusion.
    await rule('Use e-mail notifications');
    expect((await search(db, { query: 'e-mail' })).map((h) => h.title)).toEqual(['Use e-mail notifications']);
  });

  it('user input with tsquery syntax never throws', async () => {
    await rule('Alpha rule');
    for (const query of ["a:* & !(b | 'c')", "'", '\\', '<->', ':*', '!!!', '&|', 'foo "bar', '-', '"', 'OR', "alpha'"]) {
      await expect(search(db, { query }), query).resolves.toBeInstanceOf(Array);
      await expect(listMemories(db, { q: query }), query).resolves.toBeInstanceOf(Array);
    }
    expect((await search(db, { query: "alpha'" })).map((h) => h.title)).toEqual(['Alpha rule']);
    expect((await search(db, { query: 'alp:*' })).map((h) => h.title)).toEqual(['Alpha rule']);
  });
});

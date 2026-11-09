import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { findThoughts } from '../../src/domain/thoughts.js';

const DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const UPGRADE_DB = 'tabula_upgrade_test';

/** The migration files in order, each split into its statements. */
const migrations = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, statements: readFileSync(DIR + file, 'utf8').split('--> statement-breakpoint') }));

let admin: postgres.Sql;
let client: postgres.Sql;
let upgradeUrl: string;

async function apply(files: typeof migrations) {
  for (const m of files) for (const s of m.statements) await client.unsafe(s);
}

beforeAll(async () => {
  const url = new URL(inject('databaseUrl'));
  admin = postgres(url.href, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_DB}`);
  await admin.unsafe(`CREATE DATABASE ${UPGRADE_DB}`);
  url.pathname = `/${UPGRADE_DB}`;
  upgradeUrl = url.href;
  client = postgres(upgradeUrl, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await client.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_DB}`);
  await admin.end();
});

describe('upgrade to diacritics-free search (migrations 0011, 0012)', () => {
  it('makes accented content that existed before the upgrade searchable without diacritics', async () => {
    const before = migrations.filter((m) => m.file < '0011');
    const after = migrations.filter((m) => m.file >= '0011');
    expect(after.slice(0, 2).map((m) => m.file.slice(0, 4))).toEqual(['0011', '0012']);

    await apply(before);
    await client`INSERT INTO thoughts (title, body, source, edited_by) VALUES ('Grafická karta', 'Nová grafická karta', 'human', 'human')`;
    const old = await client`SELECT count(*)::int AS n FROM thoughts WHERE search @@ to_tsquery('simple', 'graficka:*')`;
    expect(old[0]!.n).toBe(0);

    await apply(after);
    const { db, close } = createDb(upgradeUrl);
    try {
      expect((await findThoughts(db, { query: 'graficka' })).map((h) => h.title)).toEqual(['Grafická karta']);
      expect((await findThoughts(db, { query: 'GRAFICKA' })).map((h) => h.title)).toEqual(['Grafická karta']);
    } finally {
      await close();
    }
  });
});

describe('upgrade to speaker recognition (migration 0013)', () => {
  it('leaves transcripts that existed before without diarization and without names', async () => {
    const name = 'tabula_upgrade_speakers';
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(upgradeUrl);
    url.pathname = `/${name}`;
    const c = postgres(url.href, { max: 1, onnotice: () => {} });
    try {
      for (const m of migrations.filter((x) => x.file < '0013')) for (const s of m.statements) await c.unsafe(s);
      await c`INSERT INTO projects (id, name) VALUES ('demo', 'demo')`;
      const [r] = await c`INSERT INTO reports (project_id, title, source, edited_by) VALUES ('demo', 'Old report', 'human', 'human') RETURNING id`;
      const [a] = await c`
        INSERT INTO report_attachments (report_id, kind, mime, size, sha256, file_name, storage_key, created_by)
        VALUES (${r!.id}, 'audio', 'audio/wav', 10, 'x', 'voice.wav', 'k', 'human') RETURNING id`;
      await c`INSERT INTO report_transcripts (attachment_id, model, text, segments) VALUES (${a!.id}, 'large-v3', 'Ahoj.', ${c.json([{ start_ms: 0, end_ms: 900, text: 'Ahoj.' }])})`;
      for (const m of migrations.filter((x) => x.file >= '0013')) for (const s of m.statements) await c.unsafe(s);
      const rows = await c`SELECT diarization, speakers FROM report_transcripts`;
      expect([...rows]).toEqual([{ diarization: null, speakers: {} }]);
    } finally {
      await c.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
    }
  });
});

describe('upgrade to optional projects and Keep media (migration 0014)', () => {
  it('keeps the project of existing reports, sets keep_media to false, and takes a report without a project', async () => {
    const name = 'tabula_upgrade_reports';
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(upgradeUrl);
    url.pathname = `/${name}`;
    const c = postgres(url.href, { max: 1, onnotice: () => {} });
    try {
      for (const m of migrations.filter((x) => x.file < '0014')) for (const s of m.statements) await c.unsafe(s);
      await c`INSERT INTO projects (id, name) VALUES ('demo', 'demo')`;
      await c`INSERT INTO reports (project_id, title, source, edited_by) VALUES ('demo', 'Old report', 'human', 'human')`;
      for (const m of migrations.filter((x) => x.file >= '0014')) for (const s of m.statements) await c.unsafe(s);
      expect([...(await c`SELECT project_id, keep_media FROM reports`)]).toEqual([{ project_id: 'demo', keep_media: false }]);
      await c`INSERT INTO reports (title, source, edited_by) VALUES ('Meeting', 'human', 'human')`;
      expect((await c`SELECT count(*)::int AS n FROM reports WHERE project_id IS NULL`)[0]!.n).toBe(1);
    } finally {
      await c.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
    }
  });
});

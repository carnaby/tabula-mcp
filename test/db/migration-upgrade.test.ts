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

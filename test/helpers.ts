import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, inject } from 'vitest';
import type { Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { projects } from '../src/db/schema.js';

export function useTestDb(): Db {
  const { db, close } = createDb(inject('databaseUrl'));
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE memories, notes, thoughts CASCADE`);
    await db.execute(sql`DELETE FROM projects WHERE id <> 'global'`);
  });
  afterAll(close);
  return db;
}

export async function seedProject(db: Db, id: string): Promise<void> {
  await db.insert(projects).values({ id, name: id, description: `${id} project` });
}

export const TEST_TOKEN = 't'.repeat(32);
export const TEST_SECRET = 's'.repeat(32);

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: 'unused-in-tests',
    token: TEST_TOKEN,
    connectorSecret: TEST_SECRET,
    port: 0,
    host: '127.0.0.1',
    webDist: 'does-not-exist',
    ...overrides,
  };
}

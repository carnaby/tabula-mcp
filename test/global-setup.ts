import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/db/migrate.js';

let container: StartedPostgreSqlContainer | undefined;

/** The tests TRUNCATE tables, so an external database must be clearly a throwaway one. */
function assertThrowawayDatabase(url: string): void {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/(^|_)test($|_)/i.test(name)) {
    throw new Error(`TEST_DATABASE_URL must point to a database whose name contains "test" (e.g. tabula_test); got "${name}". The tests wipe its data.`);
  }
  if (url === process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL: the tests wipe its data.');
}

// TEST_DATABASE_URL points the tests at an existing, throwaway Postgres (e.g. where Docker is not available).
// Its data is wiped between tests.
export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    url = container.getConnectionUri();
  } else assertThrowawayDatabase(url);
  await runMigrations(url);
  project.provide('databaseUrl', url);
  return async () => {
    await container?.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

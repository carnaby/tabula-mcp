import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_TOKEN, useTestDb } from '../helpers.js';
import { runCli, tempDir, useServer } from './harness.js';

const db = useTestDb();
const server = useServer(db);
const env = (home: string) => ({ TABULA_HOME: home, TABULA_URL: undefined, TABULA_TOKEN: undefined, TABULA_WORKER_TOKEN: undefined });

describe('config.json', () => {
  it('login keeps the worker settings', async () => {
    const home = tempDir('tabula home ');
    const worker = { token: 'w'.repeat(32), language: 'en', initial_prompt: 'Tabula, prehrávač' };
    writeFileSync(join(home, 'config.json'), JSON.stringify({ url: 'http://old.example.com', token: 'old', worker }));
    const r = await runCli(['login', server.url, '--token-stdin'], { cwd: home, env: env(home), input: TEST_TOKEN });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({ url: server.url, token: TEST_TOKEN, worker });
  });

  it('login replaces a config.json that is not valid JSON', async () => {
    const home = tempDir('tabula home ');
    writeFileSync(join(home, 'config.json'), '{ broken');
    const r = await runCli(['login', server.url, '--token-stdin'], { cwd: home, env: env(home), input: TEST_TOKEN });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({ url: server.url, token: TEST_TOKEN });
  });
});

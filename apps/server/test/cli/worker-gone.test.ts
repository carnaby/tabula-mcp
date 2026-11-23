import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_TOKEN, useTestDb, useTestTokens } from '../helpers.js';
import { runCli, tempDir, useServer } from './harness.js';

const db = useTestDb();
useTestTokens(db);
const server = useServer(db);
const env = (home: string) => ({ TABULA_HOME: home, TABULA_URL: undefined, TABULA_TOKEN: undefined, TABULA_WORKER_TOKEN: undefined });

describe('the transcription worker moved to Fornax', { timeout: 60_000 }, () => {
  it.each([[[]], [['setup']], [['doctor']], [['queue', '--json']], [['--once']], [['bogus']]])(
    'tabula worker %j prints one line about Fornax and exits 2',
    async (rest) => {
      const home = tempDir('tabula-home-');
      const r = await runCli(['worker', ...rest], { cwd: home, env: env(home) });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).toContain('Fornax');
      expect(r.stderr).toContain('https://github.com/carnaby/fornax-mcp');
      expect(r.stderr).toContain('tabula');
    },
  );

  it('tabula help no longer lists the worker commands', async () => {
    const home = tempDir('tabula-home-');
    const r = await runCli(['help'], { cwd: home, env: env(home) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('tabula push');
    expect(r.stdout).not.toMatch(/worker|whisper|diariz|transcri|ffmpeg|Python/i);
  });

  it('ignores an old worker key in config.json and login keeps it as it is', async () => {
    const home = tempDir('tabula-home-');
    const worker = { token: 'w'.repeat(32), language: 'en', diarize: { python: 'x', script: 'y' } };
    writeFileSync(join(home, 'config.json'), JSON.stringify({ url: server.url, token: TEST_TOKEN, worker }));
    const v = await runCli(['status'], { cwd: home, env: env(home) });
    expect(v.stderr).not.toMatch(/worker/i);
    const r = await runCli(['login', server.url, '--token-stdin'], { cwd: home, env: env(home), input: TEST_TOKEN });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({ url: server.url, token: TEST_TOKEN, worker });
  });

  it('login replaces a config.json that is not valid JSON', async () => {
    const home = tempDir('tabula-home-');
    writeFileSync(join(home, 'config.json'), '{ broken');
    const r = await runCli(['login', server.url, '--token-stdin'], { cwd: home, env: env(home), input: TEST_TOKEN });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({ url: server.url, token: TEST_TOKEN });
  });
});

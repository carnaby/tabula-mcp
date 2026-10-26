import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { seedProject, TEST_TOKEN, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config: testConfig(), db });
});
afterAll(() => app.close());
beforeEach(() => seedProject(db, 'demo'));

const auth = { authorization: `Bearer ${TEST_TOKEN}` };
const cli = { ...auth, 'x-tabula-agent': 'cli' };
const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = cli) =>
  app.inject({ method, url, headers, ...(payload && { payload }) });
const put = (path: string, content: string, base_sha256: string | null, force?: boolean) =>
  call('PUT', '/api/projects/demo/files', { path, content, base_sha256, ...(force !== undefined && { force }) });
const q = encodeURIComponent;

describe('files REST API', () => {
  it('requires the bearer token on every file route', async () => {
    const routes = [
      ['GET', '/api/projects/demo/files'], ['GET', '/api/projects/demo/files/content?path=a.md'],
      ['PUT', '/api/projects/demo/files'], ['DELETE', '/api/projects/demo/files?path=a.md'],
      ['POST', '/api/projects/demo/files/restore'], ['GET', '/api/projects/demo/files/revisions?path=a.md'],
      ['GET', '/api/projects/demo/files/revisions/content?path=a.md&version=1'], ['PUT', '/api/projects/demo/files/state'],
    ] as const;
    for (const [method, url] of routes) expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
  });

  it('uploads, lists, reads, detects conflicts and forces, with spaces and diacritics in the path', async () => {
    const path = 'docs/plány/stav 1.md';
    const v1 = await put(path, '# Stav', null);
    expect(v1.statusCode).toBe(200);
    expect(v1.json()).toMatchObject({ version: 1, changed: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await call('GET', '/api/projects/demo/files')).json()).toMatchObject([
      { path, size: 6, version: 1, updatedBy: 'cli', isState: false, deletedAt: null },
    ]);
    expect((await call('GET', `/api/projects/demo/files/content?path=${q(path)}`)).json()).toMatchObject({
      content: '# Stav', sha256: v1.json().sha256,
    });
    const v2 = (await put(path, '# Stav 2', v1.json().sha256)).json();
    const stale = await put(path, '# Mine', v1.json().sha256);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'conflict', sha256: v2.sha256 });
    expect((await put(path, '# Mine', v1.json().sha256, true)).json()).toMatchObject({ version: 3 });
  });

  it('writes as the human when no agent header is sent (the UI)', async () => {
    await call('PUT', '/api/projects/demo/files', { path: 'a.md', content: 'x', base_sha256: null }, auth);
    expect((await call('GET', '/api/projects/demo/files')).json()[0]).toMatchObject({ updatedBy: 'human' });
  });

  it('accepts a 1 MiB file whose JSON body is larger than 1 MiB, and refuses one byte more with 413', async () => {
    const line = 'say "hi"\n'; // quotes and newlines grow when JSON-escaped
    const big = line.repeat(Math.floor(1_048_576 / line.length)).padEnd(1_048_576, 'x');
    expect(Buffer.byteLength(big)).toBe(1_048_576);
    expect((await put('docs/big.md', big, null)).statusCode).toBe(200);
    const over = await put('docs/over.md', `${big}x`, null);
    expect(over.statusCode).toBe(413);
    expect(over.json().message).toMatch(/limit is 1048576/);
  });

  it('rejects invalid paths and content with 400, unknown projects and files with 404', async () => {
    for (const path of ['../x.md', '/abs.md', 'docs\\a.md', '.env', 'docs/.env.local', '.git/config']) {
      expect((await put(path, 'x', null)).statusCode, path).toBe(400);
    }
    expect((await put('docs/nul.md', `a${String.fromCharCode(0)}`, null)).statusCode).toBe(400);
    expect((await call('PUT', '/api/projects/demo/files', { path: 'a.md', content: 'x' })).statusCode).toBe(400);
    expect((await call('GET', '/api/projects/nope/files')).statusCode).toBe(404);
    expect((await call('GET', '/api/projects/demo/files/content?path=missing.md')).statusCode).toBe(404);
  });

  it('soft-deletes, lists deleted files on request, restores, and serves revisions', async () => {
    const v1 = (await put('docs/a.md', 'one', null)).json();
    await put('docs/a.md', 'two', v1.sha256);
    expect((await call('DELETE', `/api/projects/demo/files?path=${q('docs/a.md')}`)).json()).toEqual({ changed: true });
    expect((await call('GET', '/api/projects/demo/files')).json()).toEqual([]);
    expect((await call('GET', '/api/projects/demo/files?deleted=1')).json()).toMatchObject([
      { path: 'docs/a.md', deletedAt: expect.any(String) },
    ]);
    expect((await call('POST', '/api/projects/demo/files/restore', { path: 'docs/a.md' })).json()).toEqual({ changed: true });
    expect((await call('GET', `/api/projects/demo/files/revisions?path=${q('docs/a.md')}`)).json()).toMatchObject([
      { version: 1, updatedBy: 'cli' },
    ]);
    const rev = await call('GET', `/api/projects/demo/files/revisions/content?path=${q('docs/a.md')}&version=1`);
    expect(rev.json()).toMatchObject({ version: 1, content: 'one' });
    expect((await call('GET', `/api/projects/demo/files/revisions/content?path=${q('docs/a.md')}&version=9`)).statusCode).toBe(404);
  });

  it('marks state files and finds files in the quick search by a word of the path', async () => {
    await put('docs/handoff/state.md', 'Current focus: drizzle migrations', null);
    expect((await call('PUT', '/api/projects/demo/files/state', { paths: ['docs/handoff/state.md'] })).json()).toEqual({ updated: 1 });
    expect((await call('GET', '/api/projects/demo/files')).json()[0]).toMatchObject({ isState: true });
    expect((await call('GET', '/api/search?q=handoff')).json()).toMatchObject([
      { type: 'file', project: 'demo', title: 'docs/handoff/state.md' },
    ]);
  });
});

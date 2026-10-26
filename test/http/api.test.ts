import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { TEST_TOKEN, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config: testConfig(), db });
  app.get('/__boom', () => {
    throw new Error('Failed query: SELECT secret FROM x');
  });
});
afterAll(() => app.close());

const auth = { authorization: `Bearer ${TEST_TOKEN}` };
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: auth, ...(payload && { payload }) });

describe('REST API', () => {
  it('requires the bearer token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401);
  });

  it('requires the token on the search, thoughts and snippet routes too', async () => {
    for (const url of ['/api/search?q=x', '/api/thoughts', '/api/projects/global/snippet']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });

  it('manages projects', async () => {
    expect((await call('POST', '/api/projects', { id: 'demo', name: 'Demo' })).statusCode).toBe(201);
    expect((await call('POST', '/api/projects', { id: 'Bad Slug', name: 'x' })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/projects/demo', { description: 'd' })).json()).toMatchObject({ description: 'd' });
    expect((await call('GET', '/api/projects')).json().map((p: { id: string }) => p.id)).toEqual(['global', 'demo']);
  });

  it('runs the memory lifecycle as a human', async () => {
    await call('POST', '/api/projects', { id: 'demo', name: 'Demo' });
    const created = await call('POST', '/api/memories', { projectId: 'demo', kind: 'rule', title: 'T', body: 'B' });
    expect(created.statusCode).toBe(201);
    const m = created.json();
    expect(m).toMatchObject({ source: 'human', agentLabel: null });

    expect((await call('PATCH', `/api/memories/${m.id}`, { title: 'T2' })).json()).toMatchObject({ title: 'T2' });
    expect((await call('GET', `/api/memories/${m.id}`)).json()).toMatchObject({ id: m.id, title: 'T2' });
    expect((await call('PATCH', `/api/memories/${m.id}`, { title: 'x'.repeat(121) })).statusCode).toBe(400);

    const v2 = (await call('POST', '/api/memories', { projectId: 'demo', kind: 'rule', title: 'T3', body: 'B', supersedesId: m.id })).json();
    expect((await call('GET', `/api/memories/${v2.id}/chain`)).json().map((x: { id: string }) => x.id)).toEqual([m.id, v2.id]);

    expect((await call('GET', '/api/memories?project=demo')).json()).toMatchObject({ total: 1, page: 1 });
    expect((await call('GET', '/api/memories?project=demo&status=all')).json().items).toHaveLength(2);
    expect((await call('POST', `/api/memories/${v2.id}/deprecate`, { reason: 'old' })).json()).toEqual({ changed: true });
    expect((await call('DELETE', `/api/memories/${v2.id}`)).statusCode).toBe(204);
    expect((await call('DELETE', `/api/memories/${v2.id}`)).statusCode).toBe(404);
  });

  it('manages notes with size estimates and shows the recall preview', async () => {
    await call('POST', '/api/projects', { id: 'demo', name: 'Demo' });
    const n = (await call('POST', '/api/notes', { projectId: 'demo', title: 'Protocol', body: 'one two three four' })).json();
    expect(n).toMatchObject({ wordCount: 4, tokenEstimate: 5, pinned: false });
    expect((await call('PATCH', `/api/notes/${n.id}`, { pinned: true })).json()).toMatchObject({ pinned: true });
    expect((await call('GET', '/api/notes?project=demo')).json()).toMatchObject({ total: 1, items: [{ wordCount: 4 }] });

    const preview = (await call('GET', '/api/recall/demo')).json();
    expect(preview).toMatchObject({ budget: 3000, overBudget: false, trimmed: [] });
    expect(preview.text).toContain('# Tabula · demo · ');
    expect(preview.text).not.toContain('Protocol'); // notes never go into recall
    expect(preview.tokens).toBeGreaterThan(0);
    expect((await call('GET', '/api/recall/demo?state=0')).statusCode).toBe(200);

    expect((await call('DELETE', `/api/notes/${n.id}`)).statusCode).toBe(204);
    expect((await call('GET', '/api/recall/nope')).statusCode).toBe(404);
  });

  it('validates enum query params', async () => {
    expect((await call('GET', '/api/memories?kind=nonsense')).statusCode).toBe(400);
    expect((await call('GET', '/api/memories?sort=body')).statusCode).toBe(400);
    expect((await call('GET', '/api/memories?pageSize=1000')).statusCode).toBe(400);
  });

  it('paginates, sorts and prefix-searches memories', async () => {
    await call('POST', '/api/projects', { id: 'demo', name: 'Demo' });
    for (const t of ['Alpha', 'Bravo', 'Charlie', 'Drizzle over Prisma', 'Echo']) {
      await call('POST', '/api/memories', { projectId: 'demo', kind: 'fact', title: t, body: 'b' });
    }
    const p2 = (await call('GET', '/api/memories?pageSize=2&page=2&sort=title&dir=asc')).json();
    expect(p2).toMatchObject({ total: 5, page: 2, pageSize: 2 });
    expect(p2.items.map((m: { title: string }) => m.title)).toEqual(['Charlie', 'Drizzle over Prisma']);
    const hits = (await call('GET', '/api/memories?q=drizz%20ov')).json();
    expect(hits.items.map((m: { title: string }) => m.title)).toEqual(['Drizzle over Prisma']);
    expect((await call('GET', `/api/memories?q=${encodeURIComponent('a:* & (')}`)).statusCode).toBe(200);
  });

  it('manages thoughts with revisions, conflicts and restore', async () => {
    const t = (await call('POST', '/api/thoughts', { title: 'Idea', body: 'first', tags: ['Music'] })).json();
    expect(t).toMatchObject({ version: 1, source: 'human', editedBy: 'human', tags: ['music'] });

    const v2 = (await call('PATCH', `/api/thoughts/${t.id}`, { body: 'second', expectedVersion: 1 })).json();
    expect(v2).toMatchObject({ version: 2, body: 'second' });
    expect((await call('PATCH', `/api/thoughts/${t.id}`, { body: 'stale', expectedVersion: 1 })).statusCode).toBe(409);

    // Pinning is not a content change.
    expect((await call('PATCH', `/api/thoughts/${t.id}`, { pinned: true })).json()).toMatchObject({ version: 2, pinned: true });

    const revs = (await call('GET', `/api/thoughts/${t.id}/revisions`)).json();
    expect(revs.map((r: { version: number; body: string }) => [r.version, r.body])).toEqual([[1, 'first']]);
    const restored = (await call('POST', `/api/thoughts/${t.id}/revisions/${revs[0].id}/restore`)).json();
    expect(restored).toMatchObject({ version: 3, body: 'first' });

    expect((await call('GET', '/api/thoughts?tag=music')).json()).toMatchObject({ total: 1 });
    expect((await call('GET', '/api/thoughts/tags')).json()).toEqual([{ tag: 'music', count: 1 }]);
    await call('PATCH', `/api/thoughts/${t.id}`, { archived: true });
    expect((await call('GET', '/api/thoughts')).json()).toMatchObject({ total: 0 });
    expect((await call('GET', '/api/thoughts?archived=true')).json()).toMatchObject({ total: 1 });

    expect((await call('DELETE', `/api/thoughts/${t.id}`)).statusCode).toBe(204);
    expect((await call('GET', `/api/thoughts/${t.id}`)).statusCode).toBe(404);
  });

  it('searches memories, notes and thoughts at once and serves the CLAUDE.md snippet', async () => {
    await call('POST', '/api/projects', { id: 'demo', name: 'Demo' });
    await call('POST', '/api/memories', { projectId: 'demo', kind: 'fact', title: 'Suno download cap', body: 'b' });
    await call('POST', '/api/notes', { projectId: 'demo', title: 'Suno workflow', body: 'x' });
    await call('POST', '/api/thoughts', { title: 'Suno prompts that work', body: 'y' });
    const hits = (await call('GET', '/api/search?q=sun')).json();
    expect(hits.map((h: { type: string }) => h.type).sort()).toEqual(['memory', 'note', 'thought']);
    expect((await call('GET', '/api/search?q=')).json()).toEqual([]);
    expect((await call('GET', '/api/projects/demo/snippet')).json().text).toContain('`demo`');
    expect((await call('GET', '/api/projects/nope/snippet')).statusCode).toBe(404);
  });

  it('does not leak internal error details in 500 responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/__boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal', message: 'internal error' });
    expect(res.body).not.toContain('secret');
  });

  it('keeps notebook notes without a project and lists their tags', async () => {
    const n = await call('POST', '/api/notes', { title: 'Loose idea', body: 'x', tags: ['Music'] });
    expect(n.statusCode).toBe(201);
    expect(n.json()).toMatchObject({ projectId: null, tags: ['music'] });
    expect((await call('GET', '/api/notes?tag=music')).json()).toMatchObject({ total: 1 });
    expect((await call('GET', '/api/notes/tags')).json()).toEqual([{ tag: 'music', count: 1 }]);
  });
});

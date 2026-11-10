import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNote } from '../../src/domain/notes.js';
import { buildApp } from '../../src/http/app.js';
import { seedProject, TEST_TOKEN, TEST_WORKER_TOKEN, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config: testConfig(), db });
});
afterAll(() => app.close());

const as = (token: string) => ({ authorization: `Bearer ${token}` });
const get = (query: string) => app.inject({ method: 'GET', url: `/api/activity${query}`, headers: as(TEST_TOKEN) });

describe('GET /api/activity', () => {
  it('answers the timeline and checks before, type and tz', async () => {
    const empty = await get('?tz=Europe%2FBratislava');
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ days: [], next_before: null });

    await seedProject(db, 'demo');
    await createNote(db, { projectId: 'demo', title: 'Idea' });
    const before = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    const res = await get(`?type=notes&before=${before}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().days[0].items).toEqual([expect.objectContaining({ type: 'note', action: 'New note', title: 'Idea', project: 'demo', by: 'human' })]);

    for (const bad of ['?before=yesterday', '?type=memories', '?tz=Mars%2FBase']) expect((await get(bad)).statusCode).toBe(400);
    // Only an ISO date and time with an offset, in years 2000–2100; nothing else may reach the date arithmetic.
    for (const before of ['Nov 9 2026', '2026', '2026-11-09T10:00:00', '+275760-01-01T00:00:00Z', '9999-01-01T00:00:00Z', '1999-12-31T23:59:59Z']) {
      const r = await get(`?before=${encodeURIComponent(before)}`);
      expect([before, r.statusCode, r.json().message]).toEqual([before, 400, expect.stringContaining('before')]);
    }
    expect((await get(`?before=${encodeURIComponent('2026-11-10T00:00:00+01:00')}`)).statusCode).toBe(200);
  });

  it('takes after like before, and not both', async () => {
    const after = encodeURIComponent('2026-11-09T00:00:00Z');
    expect((await get(`?after=${after}`)).statusCode).toBe(200);
    for (const bad of ['yesterday', '2026-11-09T10:00:00', '1999-12-31T23:59:59Z', '9999-01-01T00:00:00Z']) {
      const r = await get(`?after=${encodeURIComponent(bad)}`);
      expect([bad, r.statusCode, r.json().message]).toEqual([bad, 400, expect.stringContaining('after')]);
    }
    const both = await get(`?after=${after}&before=${encodeURIComponent('2026-11-10T00:00:00Z')}`);
    expect([both.statusCode, both.json().message]).toEqual([400, expect.stringContaining('together')]);
  });

  it('needs the user token; the worker token is refused', async () => {
    for (const headers of [{}, as(TEST_WORKER_TOKEN)]) {
      expect((await app.inject({ method: 'GET', url: '/api/activity', headers })).statusCode).toBe(401);
    }
  });
});

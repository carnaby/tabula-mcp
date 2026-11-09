import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateReport } from '../../src/domain/reports.js';
import { buildApp } from '../../src/http/app.js';
import { seedProject, TEST_TOKEN, TEST_WORKER_TOKEN, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config: testConfig(), db });
});
afterAll(() => app.close());

const as = (token: string) => ({ authorization: `Bearer ${token}` });
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url, headers: as(TEST_TOKEN), ...(payload && { payload }) });

describe('GET /api/dashboard', () => {
  it('answers what waits, the warnings and the projects, with the recall budget and the grace period', async () => {
    await seedProject(db, 'demo');
    const created = (await call('POST', '/api/reports', { projectId: 'demo', title: 'Player freezes' })).json();

    const res = await call('GET', '/api/dashboard');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ recall_budget: 3000, purge_after_hours: 24, warnings: [] });
    expect(body.waiting).toEqual([
      expect.objectContaining({ type: 'new_report', id: created.id, title: 'Player freezes', project: 'demo', version: 1, transcript: null }),
    ]);
    expect(body.projects).toEqual([expect.objectContaining({ id: 'demo', name: 'demo', file_count: 0, open_reports: 1 })]);
  });

  it('says whether transcription is enabled: it is not without a worker token', async () => {
    expect((await call('GET', '/api/dashboard')).json().transcription_enabled).toBe(true);
    const bare = await buildApp({ config: testConfig({ workerToken: undefined }), db });
    try {
      const res = await bare.inject({ method: 'GET', url: '/api/dashboard', headers: as(TEST_TOKEN) });
      expect(res.json().transcription_enabled).toBe(false);
    } finally {
      await bare.close();
    }
  });

  it('refuses a stale Mark done: the report changed after the dashboard was read', async () => {
    await seedProject(db, 'demo');
    const created = (await call('POST', '/api/reports', { projectId: 'demo', title: 'Player freezes' })).json();
    const [item] = (await call('GET', '/api/dashboard')).json().waiting;
    await updateReport(db, created.id, { triage: 'Cause: a race.', status: 'triaged' }, { source: 'agent', label: 'claude-code' });

    const stale = await call('PATCH', `/api/reports/${created.id}`, { status: 'done', expectedVersion: item.version });
    expect(stale.statusCode).toBe(409);
    expect((await call('GET', `/api/reports/${created.id}`)).json()).toMatchObject({ status: 'triaged', version: 2 });
  });

  it('needs the user token; the worker token is refused', async () => {
    for (const headers of [{}, as(TEST_WORKER_TOKEN)]) {
      expect((await app.inject({ method: 'GET', url: '/api/dashboard', headers })).statusCode).toBe(401);
    }
  });
});

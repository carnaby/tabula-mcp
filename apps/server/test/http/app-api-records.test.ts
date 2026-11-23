import { refOf } from '@tabula/shared/refs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notes, reports, thoughts } from '../../src/db/schema.js';
import { getNote } from '../../src/domain/notes.js';
import { getReport } from '../../src/domain/reports.js';
import { getThought } from '../../src/domain/thoughts.js';
import { buildApp } from '../../src/http/app.js';
import { seedProject, TEST_APP_TOKEN, testConfig, useTestAppToken, useTestDb } from '../helpers.js';

const db = useTestDb();
useTestAppToken(db);
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config: testConfig(), db });
});
afterAll(() => app.close());
beforeEach(() => seedProject(db, 'beta'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUL = String.fromCharCode(0);
const auth = { authorization: `Bearer ${TEST_APP_TOKEN}` };
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: auth, payload: payload as object });
const created = (body: { id: string }) => expect(body).toEqual({ id: expect.stringMatching(UUID), ref: refOf(body.id) });

describe('POST /app-api/v1/thoughts', () => {
  it('saves a thought as the owner, signed by the connection, with the model only when given', async () => {
    const res = await post('/app-api/v1/thoughts', { title: 'Garden', body: 'Plant garlic in October.', tags: ['Home'], model: 'Claude Opus 5.5' });
    expect(res.statusCode).toBe(201);
    created(res.json());
    expect(await getThought(db, res.json().id)).toMatchObject({
      title: 'Garden', body: 'Plant garlic in October.', tags: ['home'], source: 'human', editedBy: 'klara', editedByModel: 'claude-opus-5.5',
    });
    const plain = (await post('/app-api/v1/thoughts', { title: 'Plain', body: 'No model.' })).json();
    expect((await getThought(db, plain.id))!.editedByModel).toBeNull();
  });
});

describe('POST /app-api/v1/notes', () => {
  it('saves a note in a project or in none', async () => {
    const res = await post('/app-api/v1/notes', { title: 'Wi-Fi at the cottage', body: 'Ask the neighbour.', tags: ['cottage'], project: 'beta' });
    expect(res.statusCode).toBe(201);
    created(res.json());
    expect(await getNote(db, res.json().id)).toMatchObject({ projectId: 'beta', title: 'Wi-Fi at the cottage', body: 'Ask the neighbour.', tags: ['cottage'] });
    const loose = (await post('/app-api/v1/notes', { title: 'Loose', body: '' })).json();
    expect((await getNote(db, loose.id))!.projectId).toBeNull();
  });
});

describe('POST /app-api/v1/reports', () => {
  it('creates a report from {} titled by the server, and one with every field', async () => {
    const empty = await post('/app-api/v1/reports', {});
    expect(empty.statusCode).toBe(201);
    created(empty.json());
    expect(await getReport(db, empty.json().id)).toMatchObject({ projectId: null, status: 'new', source: 'human', editedBy: 'klara', editedByModel: null });
    const full = (await post('/app-api/v1/reports', { title: 'Player freezes', body: 'On Android.', project: 'beta', model: 'claude-opus-5-5' })).json();
    expect(await getReport(db, full.id)).toMatchObject({ projectId: 'beta', title: 'Player freezes', body: 'On Android.', editedByModel: 'claude-opus-5-5' });
  });

  it('answers an empty body sent as JSON with 400 validation_failed in the API shape', async () => {
    const res = await app.inject({ method: 'POST', url: '/app-api/v1/reports', headers: { ...auth, 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'validation_failed', message: expect.any(String), issues: [{ path: '', message: expect.any(String) }] });
    expect(await db.select().from(reports)).toHaveLength(0);
  });
});

describe('refusals', () => {
  it.each([
    ['/app-api/v1/notes', { title: 'T', body: 'b', project: 'nope' }],
    ['/app-api/v1/reports', { project: 'nope' }],
  ])('answers an unknown project of %s with 404 project_not_found', async (url, payload) => {
    const res = await post(url, payload);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project_not_found', message: expect.any(String) });
  });

  it('refuses global, unknown fields and missing fields, naming the field', async () => {
    const global = await post('/app-api/v1/reports', { project: 'global' });
    expect(global.statusCode).toBe(400);
    expect(global.json()).toEqual({ error: 'validation_failed', message: expect.any(String), issues: [{ path: 'project', message: expect.any(String) }] });
    expect((await post('/app-api/v1/thoughts', { title: 'T', body: 'b', tag: ['x'] })).json().issues).toEqual([{ path: 'tag', message: 'unknown field' }]);
    expect((await post('/app-api/v1/notes', { title: 'T', body: 'b', summary: 's' })).json().issues).toEqual([{ path: 'summary', message: 'unknown field' }]);
    expect((await post('/app-api/v1/thoughts', { title: 'T' })).json().issues).toEqual([{ path: 'body', message: expect.any(String) }]);
    expect((await post('/app-api/v1/thoughts', { title: 'x'.repeat(201), body: 'b' })).json()).toMatchObject({ error: 'validation_failed', issues: [{ path: '' }] });
    expect(await db.select().from(thoughts)).toHaveLength(0);
    expect(await db.select().from(notes)).toHaveLength(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ['/app-api/v1/thoughts', { title: `a${NUL}b`, body: 'x' }],
    ['/app-api/v1/thoughts', { title: 'T', body: 'x', tags: [`a${NUL}b`] }],
    ['/app-api/v1/notes', { title: 'T', body: `a${NUL}b` }],
    ['/app-api/v1/reports', { body: `a${NUL}b` }],
    ['/app-api/v1/reports', { project: `a${NUL}b` }],
  ])('answers a NUL character in %s %j with 400 validation_failed', async (url, payload) => {
    const res = await post(url, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_failed', issues: [{ path: '' }] });
  });
});

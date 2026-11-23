import { refOf } from '@tabula/shared/refs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { messages } from '../../src/db/schema.js';
import { getMessage, listMessageEvents } from '../../src/domain/messages.js';
import { buildApp } from '../../src/http/app.js';
import { seedProject, TEST_APP_TOKEN, testConfig, useTestAppToken, useTestDb } from '../helpers.js';
import { signedInCookie } from '../oauth-flow.js';

const db = useTestDb();
useTestAppToken(db);
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config: testConfig(), db });
});
afterAll(() => app.close());
beforeEach(async () => {
  await seedProject(db, 'alpha');
  await seedProject(db, 'beta');
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUL = String.fromCharCode(0);
const auth = { authorization: `Bearer ${TEST_APP_TOKEN}` };
const post = (payload: unknown) => app.inject({ method: 'POST', url: '/app-api/v1/messages', headers: auth, payload: payload as object });
const msg = { to: 'beta', type: 'request', title: 'Renew the certificate', body: 'It expires on Friday.' };

describe('POST /app-api/v1/messages', () => {
  it('sends a message from the author, signed by the connection', async () => {
    const res = await post(msg);
    expect(res.statusCode).toBe(201);
    const m = res.json();
    expect(m).toEqual({ id: expect.stringMatching(UUID), ref: refOf(m.id), status: 'new', version: 1 });
    expect(await getMessage(db, m.id)).toMatchObject({
      toProject: 'beta', fromProject: null, type: 'request', title: 'Renew the certificate', source: 'human', createdBy: 'klara', createdByModel: null,
    });
    expect(await listMessageEvents(db, m.id)).toMatchObject([{ version: 1, toStatus: 'new', actor: 'klara', source: 'human', actorModel: null }]);
  });

  it('shows the web UI the author as sender, via the connection', async () => {
    const m = (await post(msg)).json();
    const ui = { cookie: await signedInCookie(db) };
    expect((await app.inject({ method: 'GET', url: `/api/messages/${m.id}`, headers: ui })).json()).toMatchObject({
      from: 'author', via: 'klara', to: 'beta', source: 'human', created_by: 'klara',
    });
    expect((await app.inject({ method: 'GET', url: '/api/messages?to=beta', headers: ui })).json().items[0]).toMatchObject({ from: 'author', via: 'klara' });
  });

  it('follows up a message of the same project and refuses one of another', async () => {
    const first = (await post(msg)).json();
    const follow = await post({ ...msg, title: 'One more thing', related_to: first.ref });
    expect(follow.statusCode).toBe(201);
    expect((await getMessage(db, follow.json().id))!.relatedTo).toBe(first.id);
    const other = (await post({ ...msg, to: 'alpha' })).json();
    const wrong = await post({ ...msg, related_to: other.id });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: 'validation_failed', message: expect.any(String), issues: [{ path: 'related_to', message: expect.any(String) }] });
    // An unknown message and a value that is no reference at all are refused on the same field.
    for (const related_to of ['00000000-0000-4000-8000-000000000000', 'hello']) {
      expect((await post({ ...msg, related_to })).json()).toMatchObject({ error: 'validation_failed', issues: [{ path: 'related_to' }] });
    }
  });

  it('answers an unknown project with 404 project_not_found and global with 400', async () => {
    const unknown = await post({ ...msg, to: 'nope' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'project_not_found', message: expect.any(String) });
    const global = await post({ ...msg, to: 'global' });
    expect(global.statusCode).toBe(400);
    expect(global.json()).toMatchObject({ error: 'validation_failed', issues: [{ path: 'to' }] });
  });

  it.each([
    ['an unknown field', { ...msg, from: 'alpha' }, 'from'],
    ['a wrong type', { ...msg, type: 'question' }, 'type'],
    ['a missing body', { to: 'beta', type: 'request', title: 'T' }, 'body'],
    ['a title over 200 characters', { ...msg, title: 'x'.repeat(201) }, ''],
    ['a blank body', { ...msg, body: '   ' }, ''],
    ['a NUL in the body', { ...msg, body: `a${NUL}b` }, ''],
    ['a NUL in the project', { ...msg, to: `a${NUL}b` }, ''],
  ])('refuses %s with 400 validation_failed', async (_name, payload, path) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_failed', message: expect.any(String), issues: [{ path }] });
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it('answers bodies that are not usable JSON in the API shape', async () => {
    const withType = (type: string) => ({ ...auth, 'content-type': type });
    const broken = await app.inject({ method: 'POST', url: '/app-api/v1/messages', headers: withType('application/json'), payload: '{"to":' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toEqual({ error: 'validation_failed', message: expect.any(String), issues: [{ path: '', message: expect.any(String) }] });
    const text = await app.inject({ method: 'POST', url: '/app-api/v1/messages', headers: withType('text/plain'), payload: 'Renew the certificate' });
    expect(text.statusCode).toBe(415);
    expect(text.json()).toEqual({ error: 'unsupported_media_type', message: expect.any(String) });
    const huge = await post({ ...msg, body: 'x'.repeat(1_100_000) });
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toEqual({ error: 'too_large', message: expect.any(String) });
  });
});

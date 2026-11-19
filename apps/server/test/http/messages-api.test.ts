import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { refOf } from '@tabula/shared/refs';
import { createMessageToken } from '../../src/domain/message-tokens.js';
import { createMessage, getMessage, type Message, updateMessage } from '../../src/domain/messages.js';
import { memories, messages } from '../../src/db/schema.js';
import { buildApp } from '../../src/http/app.js';
import { seedProject, TEST_TOKEN, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
let app: FastifyInstance;
let message: Message;

beforeAll(async () => {
  app = await buildApp({ config: testConfig(), db });
});
afterAll(() => app.close());
beforeEach(async () => {
  await seedProject(db, 'alpha');
  await seedProject(db, 'beta');
  message = await createMessage(db, { to: 'beta', from: 'alpha', type: 'request', title: 'Open a port', body: 'Text' }, { source: 'agent', label: 'test' });
});

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${TEST_TOKEN}` }, ...(payload && { payload }) });
const full = { source: 'human' as const, label: 'human', access: 'full' as const };

describe('/api/messages', () => {
  it('needs the full token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/messages' })).statusCode).toBe(401);
  });

  it.each(['/api/messages', '/api/messages/counts', '/api/message-tokens'])('refuses a narrow token on %s', async (url) => {
    const { value } = await createMessageToken(db, { projectId: 'beta', name: 'reader' });
    expect((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${value}` } })).statusCode).toBe(401);
  });

  it('keeps messages out of the quick search of the web', async () => {
    expect((await call('GET', '/api/search?q=port')).json()).toEqual([]);
  });

  it('lists with filters and keeps closed messages in the archive', async () => {
    expect((await call('GET', '/api/messages?to=beta&from=alpha&type=request')).json()).toMatchObject({ total: 1, items: [{ id: message.id, to: 'beta' }] });
    expect((await call('GET', '/api/messages?to=alpha')).json().total).toBe(0);
    await updateMessage(db, message.id, { expectedVersion: 1, status: 'done' }, full);
    expect((await call('GET', '/api/messages')).json().total).toBe(0);
    expect((await call('GET', '/api/messages?status=archive')).json().total).toBe(1);
    expect((await call('GET', '/api/messages?status=nonsense')).statusCode).toBe(400);
  });

  it('counts open messages', async () => {
    expect((await call('GET', '/api/messages/counts')).json()).toEqual({ open: 1, waiting_author: 0 });
  });

  it('shows the detail with history', async () => {
    expect((await call('GET', `/api/messages/${message.id}`)).json()).toMatchObject({ body: 'Text', events: [{ version: 1 }] });
    expect((await call('GET', '/api/messages/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('closes, reopens and records the human', async () => {
    const res = await call('PATCH', `/api/messages/${message.id}`, { expected_version: 1, status: 'rejected', reply: 'No' });
    expect(res.json()).toMatchObject({ status: 'rejected', version: 2 });
    const open = await call('PATCH', `/api/messages/${message.id}`, { expected_version: 2, status: 'in_progress' });
    expect(open.json()).toMatchObject({ status: 'in_progress', version: 3 });
    const detail = (await call('GET', `/api/messages/${message.id}`)).json();
    expect(detail.events[1]).toMatchObject({ actor: 'human', source: 'human', reply: 'No' });
  });

  it('never changes the sent text', async () => {
    // The reply makes the patch valid otherwise, so only the strict schema can refuse it.
    const res = await call('PATCH', `/api/messages/${message.id}`, { expected_version: 1, reply: 'x', body: 'New', title: 'New' });
    expect(res.statusCode).toBe(400);
    expect(await getMessage(db, message.id)).toMatchObject({ body: 'Text', title: 'Open a port', version: 1 });
  });

  it.each(['to', 'from'])('answers 400 for a NUL in %s', async (field) => {
    expect((await call('GET', `/api/messages?${field}=%00`)).statusCode).toBe(400);
  });

  it('answers a stale version with 409', async () => {
    await call('PATCH', `/api/messages/${message.id}`, { expected_version: 1, reply: 'One' });
    expect((await call('PATCH', `/api/messages/${message.id}`, { expected_version: 1, reply: 'Two' })).statusCode).toBe(409);
  });

  it('deletes', async () => {
    expect((await call('DELETE', `/api/messages/${message.id}`)).statusCode).toBe(204);
    expect(await getMessage(db, message.id)).toBeUndefined();
  });
});

describe('/api/message-tokens', () => {
  it('shows the value once and lists only the metadata', async () => {
    const created = await call('POST', '/api/message-tokens', { project: 'beta', name: 'reader' });
    expect(created.statusCode).toBe(201);
    const { value, token } = created.json();
    expect(value).toMatch(/^tabula_inbox_/);
    const list = await call('GET', '/api/message-tokens');
    expect(list.json()).toMatchObject([{ id: token.id, project: 'beta', name: 'reader', revoked_at: null }]);
    expect(list.body).not.toContain(value);
  });

  it('revokes a token and keeps its record', async () => {
    const { token, value } = (await call('POST', '/api/message-tokens', { project: 'beta', name: 'reader' })).json();
    expect((await call('DELETE', `/api/message-tokens/${token.id}`)).json().revoked_at).toEqual(expect.any(String));
    expect((await app.inject({ method: 'GET', url: '/inbox-api/v1/messages', headers: { authorization: `Bearer ${value}` } })).statusCode).toBe(401);
    expect((await call('GET', '/api/message-tokens')).json()).toHaveLength(1);
  });

  it('refuses a second active token with the same name in one project, and allows it once the first is revoked', async () => {
    const first = (await call('POST', '/api/message-tokens', { project: 'beta', name: 'reader' })).json();
    const twin = await call('POST', '/api/message-tokens', { project: 'beta', name: 'reader' });
    expect(twin.statusCode).toBe(409);
    expect(twin.json()).toMatchObject({ error: 'conflict', message: expect.stringMatching(/"beta" already has an active token named "reader"/) });
    expect((await call('POST', '/api/message-tokens', { project: 'alpha', name: 'reader' })).statusCode).toBe(201);
    await call('DELETE', `/api/message-tokens/${first.token.id}`);
    expect((await call('POST', '/api/message-tokens', { project: 'beta', name: 'reader' })).statusCode).toBe(201);
    expect((await call('GET', '/api/message-tokens')).json()).toHaveLength(3);
  });

  it('answers 400 for a NUL in the project', async () => {
    expect((await call('POST', '/api/message-tokens', { project: `a${String.fromCharCode(0)}b`, name: 'reader' })).statusCode).toBe(400);
  });
});

describe('references and Home', () => {
  it('resolves a message reference for the UI', async () => {
    expect((await call('GET', `/api/resolve/${refOf(message.id)}`)).json()).toMatchObject({
      type: 'message', id: message.id, project: 'beta', title: 'Open a port', status: 'new',
    });
  });

  it('lists a message among the candidates of a short reference, like any other record', async () => {
    const msg = { toProject: 'beta', fromProject: 'alpha', type: 'request' as const, body: 'x', source: 'agent' as const, createdBy: 'test' };
    await db.insert(memories).values({ id: 'abcd1000-0000-4000-8000-000000000000', projectId: 'global', kind: 'rule', title: 'Rule', body: 'b', source: 'human' });
    await db.insert(messages).values([
      { ...msg, id: 'abcd2000-0000-4000-8000-000000000000', title: 'Message' },
      { ...msg, id: 'abce1000-0000-4000-8000-000000000000', title: 'First message' },
      { ...msg, id: 'abce2000-0000-4000-8000-000000000000', title: 'Second message' },
    ]);
    const candidates = async (ref: string) => {
      const res = await call('GET', `/api/resolve/${ref}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/ambiguous/);
      return (res.json().candidates as Array<{ type: string; ref: string; title: string }>).sort((a, b) => a.ref.localeCompare(b.ref));
    };
    expect(await candidates('tabula:abcd')).toEqual([
      { type: 'memory', id: 'abcd1000-0000-4000-8000-000000000000', ref: 'tabula:abcd1000', title: 'Rule' },
      { type: 'message', id: 'abcd2000-0000-4000-8000-000000000000', ref: 'tabula:abcd2000', title: 'Message' },
    ]);
    expect((await candidates('tabula:abce')).map((c) => [c.type, c.ref])).toEqual([['message', 'tabula:abce1000'], ['message', 'tabula:abce2000']]);
    expect((await call('GET', '/api/resolve/tabula:abce1')).json()).toMatchObject({ type: 'message', id: 'abce1000-0000-4000-8000-000000000000' });
    expect((await call('GET', '/api/resolve/tabula:abcd1')).json()).toMatchObject({ type: 'memory', id: 'abcd1000-0000-4000-8000-000000000000' });
    // Eight characters shared by a record and a message are ambiguous too, as for two records.
    await db.insert(messages).values({ ...msg, id: 'abcd1000-0000-4000-8000-000000000001', title: 'Twin' });
    expect((await candidates('tabula:abcd1000')).map((c) => c.type)).toEqual(['memory', 'message']);
  });

  it('still answers 404 for an unknown reference', async () => {
    expect((await call('GET', '/api/resolve/tabula:00000000')).statusCode).toBe(404);
  });

  it('shows on Home only messages that wait for the author', async () => {
    const before = (await call('GET', '/api/dashboard')).json();
    expect(before.waiting).toEqual([]);
    await updateMessage(db, message.id, { expectedVersion: 1, status: 'waiting', waitingOn: 'sender' }, full);
    expect((await call('GET', '/api/dashboard')).json().waiting).toEqual([]);
    await updateMessage(db, message.id, { expectedVersion: 2, status: 'waiting', waitingOn: 'author' }, full);
    expect((await call('GET', '/api/dashboard')).json().waiting).toMatchObject([
      { type: 'message_waiting', id: message.id, ref: refOf(message.id), title: 'Open a port', project: 'beta', from: 'alpha', version: 3 },
    ]);
  });
});

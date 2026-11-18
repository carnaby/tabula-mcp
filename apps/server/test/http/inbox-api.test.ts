import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMessageToken, listMessageTokens, revokeMessageToken } from '../../src/domain/message-tokens.js';
import { createMessage, getMessage, listMessageEvents, type Message, updateMessage } from '../../src/domain/messages.js';
import { buildApp } from '../../src/http/app.js';
import { seedProject, TEST_SECRET, TEST_TOKEN, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
const logs: string[] = [];
let app: FastifyInstance;
let token: string;
let tokenId: string;
let message: Message;

beforeAll(async () => {
  // The suite runs at warn, where a request writes nothing; the log test needs the request lines.
  const prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  app = await buildApp({ config: testConfig(), db, logStream: { write: (m) => void logs.push(m) } });
  process.env.LOG_LEVEL = prevLevel;
});
afterAll(() => app.close());

const send = (to = 'beta', from = 'alpha') =>
  createMessage(db, { to, from, type: 'request', title: 'Open a port', body: 'SECRET-BODY', relatedTo: undefined }, { source: 'agent', label: 'test' });

beforeEach(async () => {
  await seedProject(db, 'alpha');
  await seedProject(db, 'beta');
  const created = await createMessageToken(db, { projectId: 'beta', name: 'reader' });
  token = created.value;
  tokenId = created.token.id;
  message = await send();
});

const call = (method: 'GET' | 'PATCH' | 'POST' | 'DELETE' | 'PUT', url: string, payload?: object, bearer = token) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${bearer}` }, ...(payload && { payload }) });
const base = '/inbox-api/v1/messages';

describe('narrow token issuing', () => {
  it('has the agreed format and stores only a hash', async () => {
    expect(token).toMatch(/^tabula_inbox_[A-Za-z0-9_-]{43}$/);
    const rows = await db.execute<{ row: string }>(sql`SELECT message_tokens::text AS row FROM message_tokens`);
    expect([...rows].map((r) => r.row).join()).not.toContain(token);
    expect([...rows].map((r) => r.row).join()).not.toContain(token.slice('tabula_inbox_'.length));
  });

  it('refuses a bad name, an unknown project and global', async () => {
    await expect(createMessageToken(db, { projectId: 'beta', name: 'Bad Name' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(createMessageToken(db, { projectId: 'nope', name: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(createMessageToken(db, { projectId: 'global', name: 'x' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('never writes the token to the log', async () => {
    logs.length = 0;
    await call('GET', base);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join()).not.toContain(token);
  });

  it('masks a token sent by mistake in the URL', async () => {
    logs.length = 0;
    const res = await app.inject({ method: 'GET', url: `${base}?token=${token}` });
    expect(res.statusCode).toBe(401);
    expect(logs.join()).toContain('token=tabula_inbox_***');
    expect(logs.join()).not.toContain(token.slice('tabula_inbox_'.length));
  });

  it('records when the token was last used', async () => {
    expect((await listMessageTokens(db))[0]!.last_used_at).toBeNull();
    await call('GET', base);
    expect((await listMessageTokens(db))[0]!.last_used_at).toEqual(expect.any(String));
  });
});

describe('what the narrow token opens', () => {
  it('lists open messages of its project with the agreed fields and no text', async () => {
    await send('alpha', 'beta');
    const res = await call('GET', base);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.items.map((m: { id: string }) => m.id)).toEqual([message.id]);
    expect(Object.keys(b.items[0]).sort()).toEqual([
      'created_at', 'from', 'id', 'ref', 'related_to', 'status', 'title', 'to', 'type', 'updated_at', 'version', 'waiting_on',
    ]);
    expect(res.body).not.toContain('SECRET-BODY');
    expect(b.truncated).toBe(false);
    expect(Date.parse(b.next_since)).not.toBeNaN();
  });

  it('filters by time', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await call('GET', `${base}?since=${encodeURIComponent(future)}`)).json().items).toEqual([]);
  });

  it('reads the detail, also of a closed message', async () => {
    const closed = await updateMessage(db, message.id, { expectedVersion: 1, status: 'done' }, { source: 'human', label: 'human', access: 'full' });
    const res = await call('GET', `${base}/${closed.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ body: 'SECRET-BODY', status: 'done', events: [{ version: 1 }, { version: 2 }] });
  });

  it('replies and sets in_progress or waiting, recorded under the token name', async () => {
    const res = await call('PATCH', `${base}/${message.id}`, { expected_version: 1, reply: 'Checking', status: 'in_progress' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'in_progress', version: 2 });
    const waiting = await call('PATCH', `${base}/${message.id}`, { expected_version: 2, status: 'waiting', waiting_on: 'author' });
    expect(waiting.json()).toMatchObject({ status: 'waiting', waiting_on: 'author', version: 3 });
    expect((await listMessageEvents(db, message.id))[1]).toMatchObject({ actor: 'token:reader', source: 'agent', reply: 'Checking' });
  });

  it('answers a stale version with 409', async () => {
    await call('PATCH', `${base}/${message.id}`, { expected_version: 1, reply: 'One' });
    expect((await call('PATCH', `${base}/${message.id}`, { expected_version: 1, reply: 'Two' })).statusCode).toBe(409);
  });
});

describe('what the narrow token never opens', () => {
  it('hides messages of another project', async () => {
    const foreign = await send('alpha', 'beta');
    expect((await call('GET', `${base}/${foreign.id}`)).statusCode).toBe(404);
    expect((await call('PATCH', `${base}/${foreign.id}`, { expected_version: 1, reply: 'Hi' })).statusCode).toBe(404);
    expect((await getMessage(db, foreign.id))!.version).toBe(1);
  });

  it.each([
    ['done', { expected_version: 1, status: 'done' }],
    ['rejected', { expected_version: 1, status: 'rejected', reply: 'No' }],
    ['new', { expected_version: 1, status: 'new' }],
  ])('refuses status %s', async (_name, body) => {
    expect((await call('PATCH', `${base}/${message.id}`, body)).statusCode).toBe(403);
  });

  it('refuses reopening and replying to a closed message', async () => {
    await updateMessage(db, message.id, { expectedVersion: 1, status: 'done' }, { source: 'human', label: 'human', access: 'full' });
    expect((await call('PATCH', `${base}/${message.id}`, { expected_version: 2, status: 'in_progress' })).statusCode).toBe(403);
    expect((await call('PATCH', `${base}/${message.id}`, { expected_version: 2, reply: 'Late' })).statusCode).toBe(403);
  });

  it('has no way to create or delete', async () => {
    expect((await call('POST', base, { to: 'beta' })).statusCode).toBe(404);
    expect((await call('DELETE', `${base}/${message.id}`)).statusCode).toBe(404);
    expect(await getMessage(db, message.id)).toBeDefined();
  });

  it.each([
    ['POST', '/mcp'],
    ['GET', '/api/projects'],
    ['GET', '/api/reports'],
    ['GET', '/api/notes'],
    ['GET', '/api/thoughts'],
    ['GET', '/api/memories'],
    ['GET', '/api/dashboard'],
    ['GET', '/api/resolve/tabula:abcd1234'],
  ] as const)('is refused on %s %s', async (method, url) => {
    expect((await call(method, url, method === 'POST' ? {} : undefined)).statusCode).toBe(401);
  });

  it('does not open the connector route', async () => {
    expect((await call('POST', `/mcp/${token}`, {})).statusCode).toBe(404);
  });
});

describe('authentication of the narrow API', () => {
  it.each([
    ['the full token', TEST_TOKEN],
    ['the connector secret', TEST_SECRET],
    ['an unknown token', `tabula_inbox_${'a'.repeat(43)}`],
  ])('refuses %s', async (_name, bearer) => {
    const res = await call('GET', base, undefined, bearer);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('refuses a request without a token', async () => {
    expect((await app.inject({ method: 'GET', url: base })).statusCode).toBe(401);
  });

  it('stops accepting a revoked token at once, with the same answer', async () => {
    await revokeMessageToken(db, tokenId);
    const res = await call('GET', base);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('keeps a second token of the project working', async () => {
    const second = await createMessageToken(db, { projectId: 'beta', name: 'rotated' });
    await revokeMessageToken(db, tokenId);
    expect((await call('GET', base, undefined, second.value)).statusCode).toBe(200);
  });
});

describe('malformed input', () => {
  it('answers 400 for an id that is not a uuid and for a bad since', async () => {
    expect((await call('GET', `${base}/not-a-uuid`)).statusCode).toBe(400);
    expect((await call('PATCH', `${base}/not-a-uuid`, { expected_version: 1, reply: 'x' })).statusCode).toBe(400);
    expect((await call('GET', `${base}?since=yesterday`)).statusCode).toBe(400);
  });

  it.each(['0000-01-01T00:00:00Z', '9999-12-31T23:59:59-23:59', '1999-12-31T23:59:59Z', '2100-01-01T00:00:00Z'])(
    'answers 400 for since %s, outside the years 2000 to 2099',
    async (since) => {
      expect((await call('GET', `${base}?since=${encodeURIComponent(since)}`)).statusCode).toBe(400);
    },
  );

  it('accepts since at the edges of the allowed years', async () => {
    for (const since of ['2000-01-01T00:00:00Z', '2099-12-31T23:59:59Z']) {
      expect((await call('GET', `${base}?since=${encodeURIComponent(since)}`)).statusCode).toBe(200);
    }
  });

  it.each([
    ['a text field', { expected_version: 1, reply: 'x', body: 'New text' }],
    ['a title', { expected_version: 1, reply: 'x', title: 'New title' }],
    ['no version', { reply: 'x' }],
    ['an unknown status', { expected_version: 1, status: 'closed' }],
  ])('refuses a patch with %s and changes nothing', async (_name, body) => {
    expect((await call('PATCH', `${base}/${message.id}`, body)).statusCode).toBe(400);
    expect((await getMessage(db, message.id))!).toMatchObject({ version: 1, body: 'SECRET-BODY', title: 'Open a port' });
  });

  it('refuses a body over the limit', async () => {
    const res = await call('PATCH', `${base}/${message.id}`, { expected_version: 1, reply: 'x'.repeat(130 * 1024) });
    expect(res.statusCode).toBe(413);
  });
});

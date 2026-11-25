import { refOf } from '@tabula/shared/refs';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { messages, oauthAccessTokens, oauthConnections } from '../../src/db/schema.js';
import { createMessage, type Message, updateMessage } from '../../src/domain/messages.js';
import { buildApp } from '../../src/http/app.js';
import {
  issueTestAccessToken, seedProject, TEST_APP_TOKEN, TEST_MCP_TOKEN, TEST_PUBLIC_URL, TEST_TOKEN, testConfig, useTestAppToken, useTestDb,
  useTestTokens,
} from '../helpers.js';
import { signedInCookie } from '../oauth-flow.js';

const db = useTestDb();
useTestTokens(db);
useTestAppToken(db);
/** A connection that asked for inbox:read; TEST_APP_TOKEN ("klara") has only the scope app. */
const READER_TOKEN = 'r'.repeat(32);
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config: testConfig(), db });
});
afterAll(() => app.close());
beforeEach(async () => {
  await issueTestAccessToken(db, { resource: 'app', name: 'klara-reader', scope: 'app inbox:read offline_access', value: READER_TOKEN });
  await seedProject(db, 'alpha');
  await seedProject(db, 'beta');
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const list = (query = '', token = READER_TOKEN) => app.inject({ method: 'GET', url: `/app-api/v1/messages${query}`, headers: bearer(token) });
const agent = { source: 'agent' as const, label: 'test-agent' };
const full = { ...agent, access: 'full' as const };
const send = (over: Partial<Parameters<typeof createMessage>[1]> = {}) =>
  createMessage(db, { to: 'beta', from: 'alpha', type: 'request', title: 'Open a port', body: 'Please open it.', ...over }, agent);
const fromAuthor = (over: Partial<Parameters<typeof createMessage>[1]> = {}) =>
  createMessage(db, { to: 'beta', from: null, type: 'request', title: 'from the author', body: 'B', ...over }, { source: 'human', label: 'klara' });
const at = (m: Message, iso: string) => db.update(messages).set({ updatedAt: new Date(iso) }).where(eq(messages.id, m.id));

describe('GET /app-api/v1/messages', () => {
  it('lists the open messages of every project as headers, newest change first, never their text', async () => {
    const first = await send({ title: 'Renew the certificate', body: 'SECRET-BODY-TEXT' });
    const second = await fromAuthor({ to: 'alpha', type: 'report', title: 'Song added', body: 'Rieka, in D.' });
    await at(first, '2026-11-01T10:00:00.000Z');
    await at(second, '2026-11-02T10:00:00.000Z');
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          id: second.id, ref: refOf(second.id), to: 'alpha', from: 'author', via: 'klara', type: 'report', title: 'Song added', status: 'new',
          waiting_on: null, related_to: null, version: 1, created_at: second.createdAt.toISOString(), updated_at: '2026-11-02T10:00:00.000Z',
        },
        {
          id: first.id, ref: refOf(first.id), to: 'beta', from: 'alpha', type: 'request', title: 'Renew the certificate', status: 'new',
          waiting_on: null, related_to: null, version: 1, created_at: first.createdAt.toISOString(), updated_at: '2026-11-01T10:00:00.000Z',
        },
      ],
      truncated: false,
    });
    expect(Object.keys(res.json().items[1])).not.toContain('via');
    expect(res.body).not.toContain('SECRET-BODY-TEXT');
    expect(res.body).not.toContain('Rieka');
  });

  it('filters by recipient, sender, status and who a message waits on', async () => {
    await send({ title: 'alpha to beta' });
    await send({ to: 'alpha', from: 'beta', title: 'beta to alpha' });
    await fromAuthor();
    await createMessage(db, { to: 'beta', from: null, sender: 'claude.ai chat', type: 'request', title: 'from a chat', body: 'B' }, agent);
    const w = await send({ title: 'waits on the author' });
    await updateMessage(db, w.id, { expectedVersion: 1, status: 'waiting', waitingOn: 'author' }, full);
    const d = await send({ title: 'done' });
    await updateMessage(db, d.id, { expectedVersion: 1, status: 'done' }, full);
    const titles = async (query: string) => {
      const res = await list(query);
      expect(res.statusCode, query).toBe(200);
      return (res.json().items as Array<{ title: string }>).map((m) => m.title).sort();
    };
    expect(await titles('?to=alpha')).toEqual(['beta to alpha']);
    expect(await titles('?from=alpha')).toEqual(['alpha to beta', 'waits on the author']);
    expect(await titles('?from=author')).toEqual(['from the author']);
    expect(await titles('?to=beta&from=author')).toEqual(['from the author']);
    expect(await titles('?from=external')).toEqual(['from a chat']);
    expect(await titles('?waiting_on=author')).toEqual(['waits on the author']);
    expect(await titles('?status=waiting&waiting_on=sender')).toEqual([]);
    expect(await titles('?status=done&waiting_on=author')).toEqual([]);
    expect(await titles('?status=archive')).toEqual(['done']);
    expect(await titles('?status=new&to=alpha')).toEqual(['beta to alpha']);
    expect(await titles('?status=all')).toHaveLength(6);
  });

  it('shows a message from an agent outside any project as external, with the connection and its description', async () => {
    const m = await createMessage(db, { to: 'beta', from: null, sender: 'claude.ai chat', type: 'request', title: 'from a chat', body: 'B' }, agent);
    expect((await list()).json().items).toEqual([
      expect.objectContaining({ id: m.id, from: 'external', via: 'test-agent', sender: 'claude.ai chat' }),
    ]);
  });

  it('returns 50 by default, at most limit, and says when more matched', async () => {
    await db.insert(messages).values(
      Array.from({ length: 51 }, (_, i) => ({
        toProject: 'beta', fromProject: 'alpha', type: 'request' as const, title: `m${i}`, body: 'b', source: 'agent' as const, createdBy: 'test-agent',
      })),
    );
    const byDefault = (await list()).json();
    expect(byDefault.items).toHaveLength(50);
    expect(byDefault.truncated).toBe(true);
    expect((await list('?limit=1')).json().items).toHaveLength(1);
    expect((await list('?limit=51')).json()).toMatchObject({ truncated: false });
    expect((await list('?limit=200')).json().items).toHaveLength(51);
  });

  it.each([
    ['an unknown parameter', '?box=received', 'box'],
    ['a repeated parameter', '?to=alpha&to=beta', 'to'],
    ['an empty value', '?to=', 'to'],
    ['an unknown status', '?status=closed', 'status'],
    ['an unknown waiting_on', '?waiting_on=me', 'waiting_on'],
    ['a limit of 0', '?limit=0', 'limit'],
    ['a limit over 200', '?limit=201', 'limit'],
    ['a limit that is no whole number', '?limit=1.5', 'limit'],
    ['an empty limit', '?limit=', 'limit'],
    ['global as recipient', '?to=global', 'to'],
    ['global as sender', '?from=global', 'from'],
  ])('refuses %s with 400 validation_failed', async (_name, query, path) => {
    const res = await list(query);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_failed', issues: [expect.objectContaining({ path })] });
  });

  it('refuses a NUL in a project with 400, never a server error', async () => {
    const res = await list('?to=a%00b');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('answers an unknown project with 404 project_not_found', async () => {
    for (const query of ['?to=nope', '?from=nope']) {
      const res = await list(query);
      expect(res.statusCode, query).toBe(404);
      expect(res.json()).toEqual({ error: 'project_not_found', message: expect.any(String) });
    }
  });

  it('logs neither the token nor a title', async () => {
    const logs: string[] = [];
    const prevLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    const logged = await buildApp({ config: testConfig(), db, logStream: { write: (m) => void logs.push(m) } });
    process.env.LOG_LEVEL = prevLevel;
    try {
      await send({ title: 'Title-that-must-not-be-logged' });
      const res = await logged.inject({ method: 'GET', url: '/app-api/v1/messages?to=beta', headers: bearer(READER_TOKEN) });
      expect(res.statusCode).toBe(200);
      const text = logs.join('');
      expect(text).toContain('/app-api/v1/messages');
      expect(text).not.toContain(READER_TOKEN);
      expect(text).not.toContain('Title-that-must-not-be-logged');
    } finally {
      await logged.close();
    }
  });
});

describe('the scope inbox:read', () => {
  const CHALLENGE =
    `Bearer error="insufficient_scope", scope="app inbox:read", resource_metadata="${TEST_PUBLIC_URL}/.well-known/oauth-protected-resource/app-api"`;

  it('is needed: an App API token without it gets 403 insufficient_scope and learns nothing, even about its query', async () => {
    await send();
    for (const query of ['', '?box=received', '?to=nope', '?limit=0']) {
      const res = await list(query, TEST_APP_TOKEN);
      expect(res.statusCode, query).toBe(403);
      expect(res.headers['www-authenticate']).toBe(CHALLENGE);
      expect(res.json()).toEqual({ error: 'insufficient_scope', message: expect.any(String) });
    }
  });

  it("counts the token's scope, not the connection's: a token narrowed to app reads nothing", async () => {
    const t = await issueTestAccessToken(db, { resource: 'app', name: 'klara-narrow', scope: 'app inbox:read' });
    expect((await list('', t.value)).statusCode).toBe(200);
    await db.update(oauthAccessTokens).set({ scope: 'app' }).where(eq(oauthAccessTokens.connectionId, t.connectionId));
    expect((await list('', t.value)).statusCode).toBe(403);
  });

  it('is not needed for writes', async () => {
    const res = await app.inject({ method: 'POST', url: '/app-api/v1/thoughts', headers: bearer(TEST_APP_TOKEN), payload: { title: 'T', body: 'B' } });
    expect(res.statusCode).toBe(201);
  });

  it('opens nothing without a live App API token: other tokens, a session and a revoked connection get 401', async () => {
    for (const headers of [{}, bearer(TEST_TOKEN), bearer(TEST_MCP_TOKEN), { cookie: await signedInCookie(db) }]) {
      const res = await app.inject({ method: 'GET', url: '/app-api/v1/messages', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('unauthorized');
    }
    await db.update(oauthConnections).set({ revokedAt: new Date() }).where(eq(oauthConnections.name, 'klara-reader'));
    const revoked = await list();
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().error).toBe('unauthorized');
  });
});

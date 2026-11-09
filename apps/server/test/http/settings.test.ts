import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settings } from '../../src/db/schema.js';
import { buildApp } from '../../src/http/app.js';
import { TEST_TOKEN, TEST_WORKER_TOKEN, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config: testConfig(), db });
});
afterAll(() => app.close());

const URL = '/api/settings/copy-prompt';
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const get = () => app.inject({ method: 'GET', url: URL, headers: as(TEST_TOKEN) });
const put = (payload: object) => app.inject({ method: 'PUT', url: URL, headers: as(TEST_TOKEN), payload });

describe('Copy for Claude text', () => {
  it('answers the default text until one is saved', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: 'Process report {ref}.' });
  });

  it('saves the text trimmed with Windows line ends made plain; an empty text goes back to the default', async () => {
    const saved = await put({ text: '  Process {ref}\r\nand reply in Slovak.  ' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ text: 'Process {ref}\nand reply in Slovak.' });
    expect((await get()).json()).toEqual({ text: 'Process {ref}\nand reply in Slovak.' });
    expect(await db.select().from(settings)).toHaveLength(1);

    const reset = await put({ text: '   ' });
    expect(reset.json()).toEqual({ text: 'Process report {ref}.' });
    expect(await db.select().from(settings)).toHaveLength(0);
    expect((await get()).json()).toEqual({ text: 'Process report {ref}.' });
  });

  it('takes 1 000 characters and refuses more, and refuses control characters other than a new line', async () => {
    expect((await put({ text: 'x'.repeat(1000) })).statusCode).toBe(200);
    const long = await put({ text: 'x'.repeat(1001) });
    expect(long.statusCode).toBe(400);
    expect(long.json().message).toBe('text is 1001 characters; the limit is 1000');
    for (const bad of ['a\tb', 'a\rb', `a${String.fromCharCode(0)}b`, `a${String.fromCharCode(27)}b`]) {
      const res = await put({ text: bad });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('text must not contain control characters other than a new line');
    }
    expect((await put({})).statusCode).toBe(400);
    expect((await put({ text: 'Line one\nline two {ref}' })).statusCode).toBe(200);
    expect((await get()).json()).toEqual({ text: 'Line one\nline two {ref}' });
  });

  it('needs the user token; the worker token is refused', async () => {
    for (const headers of [{}, as(TEST_WORKER_TOKEN)]) {
      expect((await app.inject({ method: 'GET', url: URL, headers })).statusCode).toBe(401);
      expect((await app.inject({ method: 'PUT', url: URL, headers, payload: { text: 'x' } })).statusCode).toBe(401);
    }
  });
});

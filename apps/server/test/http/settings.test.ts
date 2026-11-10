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

  it('takes 4 000 characters and refuses more, and refuses control characters other than a new line', async () => {
    expect((await put({ text: 'x'.repeat(4000) })).statusCode).toBe(200);
    const long = await put({ text: 'x'.repeat(4001) });
    expect(long.statusCode).toBe(400);
    expect(long.json().message).toBe('text is 4001 characters; the limit is 4000');
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

const TIDY = '/api/settings/tidy-prompt';
const getTidy = () => app.inject({ method: 'GET', url: TIDY, headers: as(TEST_TOKEN) });
const putTidy = (payload: object) => app.inject({ method: 'PUT', url: TIDY, headers: as(TEST_TOKEN), payload });

describe('tidy text', () => {
  it('answers the default text until one is saved, and an empty text goes back to it', async () => {
    const first = await getTidy();
    expect(first.statusCode).toBe(200);
    expect(first.json().text.startsWith('Tidy the Tabula recall of project {project}.')).toBe(true);
    expect((await putTidy({ text: '  Tidy {project}\r\nnow.  ' })).json()).toEqual({ text: 'Tidy {project}\nnow.' });
    expect((await getTidy()).json()).toEqual({ text: 'Tidy {project}\nnow.' });
    expect((await putTidy({ text: ' ' })).json()).toEqual(first.json());
    expect((await getTidy()).json()).toEqual(first.json());
  });

  it('keeps the two texts apart', async () => {
    await put({ text: 'Process {ref} now.' });
    await putTidy({ text: 'Tidy {project} now.' });
    expect((await get()).json()).toEqual({ text: 'Process {ref} now.' });
    await putTidy({ text: '' });
    expect((await get()).json()).toEqual({ text: 'Process {ref} now.' });
    expect((await getTidy()).json().text.startsWith('Tidy the Tabula recall')).toBe(true);
    await put({ text: '' });
  });

  it('takes 4 000 characters, refuses more and refuses control characters', async () => {
    expect((await putTidy({ text: 'x'.repeat(4000) })).statusCode).toBe(200);
    const long = await putTidy({ text: 'x'.repeat(4001) });
    expect(long.statusCode).toBe(400);
    expect(long.json().message).toBe('text is 4001 characters; the limit is 4000');
    expect((await putTidy({ text: `a${String.fromCharCode(27)}b` })).statusCode).toBe(400);
    expect((await putTidy({})).statusCode).toBe(400);
    await putTidy({ text: '' });
  });

  it('needs the user token; the worker token is refused', async () => {
    for (const headers of [{}, as(TEST_WORKER_TOKEN)]) {
      expect((await app.inject({ method: 'GET', url: TIDY, headers })).statusCode).toBe(401);
      expect((await app.inject({ method: 'PUT', url: TIDY, headers, payload: { text: 'x' } })).statusCode).toBe(401);
    }
  });
});

const COMPACT = '/api/settings/compact-prompt';
const getCompact = () => app.inject({ method: 'GET', url: COMPACT, headers: as(TEST_TOKEN) });
const putCompact = (payload: object) => app.inject({ method: 'PUT', url: COMPACT, headers: as(TEST_TOKEN), payload });

describe('compact text', () => {
  it('answers the default text until one is saved, and an empty text goes back to it', async () => {
    const first = await getCompact();
    expect(first.statusCode).toBe(200);
    expect(first.json().text.startsWith('Tidy my Tabula notebook (Thoughts).')).toBe(true);
    expect((await putCompact({ text: '  Tidy my thoughts\r\nnow.  ' })).json()).toEqual({ text: 'Tidy my thoughts\nnow.' });
    expect((await getCompact()).json()).toEqual({ text: 'Tidy my thoughts\nnow.' });
    expect((await putCompact({ text: ' ' })).json()).toEqual(first.json());
    expect((await getCompact()).json()).toEqual(first.json());
  });

  it('keeps the texts apart', async () => {
    await put({ text: 'Process {ref} now.' });
    await putTidy({ text: 'Tidy {project} now.' });
    await putCompact({ text: 'Compact now.' });
    await putCompact({ text: '' });
    expect((await get()).json()).toEqual({ text: 'Process {ref} now.' });
    expect((await getTidy()).json()).toEqual({ text: 'Tidy {project} now.' });
    await put({ text: '' });
    await putTidy({ text: '' });
    expect((await getCompact()).json().text.startsWith('Tidy my Tabula notebook')).toBe(true);
  });

  it('takes 4 000 characters, refuses more and refuses control characters', async () => {
    expect((await putCompact({ text: 'x'.repeat(4000) })).statusCode).toBe(200);
    const long = await putCompact({ text: 'x'.repeat(4001) });
    expect(long.statusCode).toBe(400);
    expect(long.json().message).toBe('text is 4001 characters; the limit is 4000');
    expect((await putCompact({ text: `a${String.fromCharCode(27)}b` })).statusCode).toBe(400);
    expect((await putCompact({})).statusCode).toBe(400);
    await putCompact({ text: '' });
  });

  it('needs the user token; the worker token is refused', async () => {
    for (const headers of [{}, as(TEST_WORKER_TOKEN)]) {
      expect((await app.inject({ method: 'GET', url: COMPACT, headers })).statusCode).toBe(401);
      expect((await app.inject({ method: 'PUT', url: COMPACT, headers, payload: { text: 'x' } })).statusCode).toBe(401);
    }
  });
});

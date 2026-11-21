import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type SQL, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isNulRefusal, loggableError, NUL_REFUSED } from '../../src/domain/errors.js';
import { buildApp } from '../../src/http/app.js';
import { issueTestAccessToken, seedProject, TEST_PUBLIC_URL, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
let app: FastifyInstance;
let base: string;
const logs: string[] = [];
beforeAll(async () => {
  app = await buildApp({ config: testConfig({ publicUrl: TEST_PUBLIC_URL }), db, logStream: { write: (m) => void logs.push(m) } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(() => app.close());
beforeEach(() => seedProject(db, 'alpha'));

async function tool(name: string, args: Record<string, unknown>) {
  const { value } = await issueTestAccessToken(db, { resource: 'mcp', name: `nul-${name.replace(/_/g, '-')}` });
  const client = new Client({ name: 'tabula-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${value}` } } }));
  try {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as Array<{ text: string }>).map((c) => c.text).join('\n'), isError: r.isError === true };
  } finally {
    await client.close();
  }
}

// Built at runtime: a literal escape in this file would be turned into a real NUL byte by some editors.
const bad = `a${String.fromCharCode(0)}b`;
const sha = 'a'.repeat(64);

describe('a NUL character', () => {
  it.each<[string, Record<string, unknown>]>([
    ['recall', { project: bad, include_state: false }],
    ['search', { query: 'x', project: bad }],
    // A quoted phrase goes to websearch_to_tsquery as typed; unquoted words are reduced to letters and digits first.
    ['search', { query: `"${bad}"` }],
    ['remember', { project: bad, kind: 'rule', title: 't', body: 'b' }],
    ['setup_project', { id: bad }],
    ['list_files', { project: bad }],
    ['read_file', { project: bad, path: 'docs/a.md' }],
    ['read_file', { project: 'alpha', path: bad }],
    ['write_file', { project: bad, path: 'docs/a.md', content: 'x' }],
    ['delete_file', { project: bad, path: 'docs/a.md', base_sha256: sha }],
    ['find_notes', { tag: bad }],
    ['list_reports', { project: bad }],
    ['create_report', { project: bad, title: 't' }],
  ])('in %s %j is a 400, not a server error', async (name, args) => {
    const r = await tool(name, args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^400: /);
  });

  it('in a project names the project argument', async () => {
    expect(await tool('list_files', { project: bad })).toEqual({ text: '400: project must not contain NUL characters', isError: true });
  });

  it('refused by Postgres in text or in jsonb counts as a refused character, another database error does not', async () => {
    const refusal = (q: SQL) => db.execute(q).then(() => 'stored', isNulRefusal);
    expect(await refusal(sql`SELECT ${bad}::text`)).toBe(true);
    expect(await refusal(sql`SELECT ${JSON.stringify({ a: bad })}::jsonb`)).toBe(true);
    expect(await refusal(sql`SELECT 1/0`)).toBe(false);
  });

  it('refused by Postgres is logged as a warning without the value, in text or in jsonb', async () => {
    const value = `hiddenword${bad}`;
    for (const q of [sql`SELECT ${value}::text`, sql`SELECT ${JSON.stringify({ a: value })}::jsonb`]) {
      const e = await db.execute(q).then(() => undefined, (err: unknown) => err);
      expect(isNulRefusal(e)).toBe(true);
      // As the log serializes an error: its enumerable fields, its message and its stack.
      const cause = (loggableError(e) as Error).cause as Error;
      expect(JSON.stringify({ ...cause, message: cause.message, stack: cause.stack })).not.toContain('hiddenword');
    }
    logs.length = 0;
    expect(await tool('search', { query: `"hiddenword${bad}"` })).toEqual({ text: `400: ${NUL_REFUSED}`, isError: true });
    const { value: api } = await issueTestAccessToken(db, { resource: 'api' });
    const res = await app.inject({ method: 'GET', url: '/api/notes?tag=hiddenword%00b', headers: { authorization: `Bearer ${api}` } });
    expect(res.statusCode).toBe(400);
    const warned = logs.map((l) => JSON.parse(l) as { level: number; msg: string }).filter((l) => l.level === 40);
    expect(warned.map((l) => l.msg)).toEqual([NUL_REFUSED, NUL_REFUSED]);
    expect(logs.join('')).not.toContain('hiddenword');
  });

  it('in an /api path is a 400', async () => {
    const { value } = await issueTestAccessToken(db, { resource: 'api' });
    const res = await app.inject({ method: 'GET', url: '/api/projects/a%00b/files', headers: { authorization: `Bearer ${value}` } });
    expect(res.statusCode).toBe(400);
  });
});

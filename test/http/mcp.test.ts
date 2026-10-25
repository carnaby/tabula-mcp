import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { projects } from '../../src/db/schema.js';
import { createMemory, getMemory } from '../../src/domain/memories.js';
import { createThought, getThought, HUMAN, listRevisions } from '../../src/domain/thoughts.js';
import { buildApp } from '../../src/http/app.js';
import { claudeMdSection } from '../../src/mcp/snippet.js';
import { seedProject, TEST_SECRET, TEST_TOKEN, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  app = await buildApp({ config: testConfig(), db });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(() => app.close());
beforeEach(() => seedProject(db, 'demo'));

async function connect(path: string, headers: Record<string, string> = {}, baseUrl = base) {
  const client = new Client({ name: 'tabula-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl + path), { requestInit: { headers } }));
  return client;
}
const bearer = { Authorization: `Bearer ${TEST_TOKEN}`, 'X-Tabula-Agent': 'claude-code' };
type Content = Array<{ type: string; text: string }>;
const textOf = (r: { content?: unknown }) => (r.content as Content)[0]!.text;

describe('MCP endpoint', () => {
  it('exposes exactly the ten tools', async () => {
    const client = await connect('/mcp', bearer);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'deprecate', 'find_thoughts', 'get', 'list_projects', 'recall', 'remember', 'save_thought', 'search',
      'setup_project', 'update_thought',
    ]);
    expect(tools.find((t) => t.name === 'recall')!.description).toMatch(/^Call at the start of a session/);
    await client.close();
  });

  it('sends server instructions on initialize', async () => {
    const client = await connect('/mcp', bearer);
    const ins = client.getInstructions();
    expect(ins).toMatch(/^Tabula is a backup memory shared across machines and clients\./);
    expect(ins).toContain('call setup_project');
    await client.close();
  });

  describe('setup_project', () => {
    const call = async (args: Record<string, unknown>) => {
      const client = await connect('/mcp', bearer);
      try {
        return await client.callTool({ name: 'setup_project', arguments: args });
      } finally {
        await client.close();
      }
    };

    it('creates a new project and returns the CLAUDE.md section', async () => {
      const r = await call({ id: 'fresh-one', description: 'A fresh project' });
      expect(r.isError).toBeFalsy();
      const out = JSON.parse(textOf(r));
      expect(out.created).toBe(true);
      expect(out.project).toMatchObject({ id: 'fresh-one', name: 'fresh-one', description: 'A fresh project' });
      expect(out.claude_md_section).toBe(claudeMdSection('fresh-one'));
    });

    it('leaves an existing project unchanged', async () => {
      const out = JSON.parse(textOf(await call({ id: 'demo', name: 'Other', description: 'changed?' })));
      expect(out.created).toBe(false);
      expect(out.project).toMatchObject({ id: 'demo', name: 'demo', description: 'demo project' });
      expect(out.claude_md_section).toContain('`demo`');
      const [row] = await db.select().from(projects).where(eq(projects.id, 'demo'));
      expect(row).toMatchObject({ name: 'demo', description: 'demo project' });
    });

    it('rejects an invalid slug with a clear error', async () => {
      const r = await call({ id: 'My Project' });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^400: project slug "My Project" is invalid: use lowercase letters, digits and dashes/);
    });

    it('rejects global', async () => {
      const r = await call({ id: 'global' });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^400: "global" is not a project to onboard/);
    });
  });

  it('remember then recall round-trips and records the agent label', async () => {
    const client = await connect('/mcp', bearer);
    const r = await client.callTool({
      name: 'remember',
      arguments: { project: 'demo', kind: 'gotcha', title: 'Cold start kills migrations', body: 'Over 60 s.' },
    });
    const { id } = JSON.parse(textOf(r)) as { id: string };
    expect(await getMemory(db, id)).toMatchObject({ source: 'agent', agentLabel: 'claude-code' });
    const digest = textOf(await client.callTool({ name: 'recall', arguments: { project: 'demo' } }));
    expect(digest).toContain('## Gotchas\n- Cold start kills migrations');
    await client.close();
  });

  it('saves, finds, appends to and reads back a thought, keeping the old version', async () => {
    const client = await connect('/mcp', bearer);
    const saved = JSON.parse(textOf(await client.callTool({
      name: 'save_thought', arguments: { title: 'Rock radio jingles', body: '## Idea\nShort stingers.', tags: ['radio'] },
    }))) as { id: string; version: number };
    expect(saved.version).toBe(1);

    const hits = JSON.parse(textOf(await client.callTool({ name: 'find_thoughts', arguments: { query: 'jingl' } })));
    expect(hits).toMatchObject([{ id: saved.id, title: 'Rock radio jingles', version: 1, edited_by: 'claude-code' }]);

    const up = JSON.parse(textOf(await client.callTool({
      name: 'update_thought', arguments: { id: saved.id, append: '## Next\nTry Suno.', expected_version: 1 },
    })));
    expect(up.version).toBe(2);
    const stale = await client.callTool({ name: 'update_thought', arguments: { id: saved.id, body: 'x', expected_version: 1 } });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toMatch(/^409: thought was changed meanwhile by claude-code/);

    const got = JSON.parse(textOf(await client.callTool({ name: 'get', arguments: { id: saved.id.slice(0, 8) } })));
    expect(got).toMatchObject({ type: 'thought', version: 2, body: '## Idea\nShort stingers.\n\n## Next\nTry Suno.' });
    expect((await listRevisions(db, saved.id)).map((r) => r.body)).toEqual(['## Idea\nShort stingers.']);

    // A thought is not a memory, and a memory is not a thought.
    const dep = await client.callTool({ name: 'deprecate', arguments: { id: saved.id, reason: 'x' } });
    expect(textOf(dep)).toMatch(/^400: .* is a thought, not a memory; use update_thought/);
    const m = await createMemory(db, { projectId: 'demo', kind: 'fact', title: 'F', body: 'b', source: 'agent' });
    const wrong = await client.callTool({ name: 'update_thought', arguments: { id: m.id, append: 'x' } });
    expect(textOf(wrong)).toMatch(/^400: .* is a memory, not a thought/);
    await client.close();
  });

  it('lets an agent edit a human thought', async () => {
    const t = await createThought(db, { title: 'Mine', body: 'human text' }, HUMAN);
    const client = await connect('/mcp', bearer);
    const r = await client.callTool({ name: 'update_thought', arguments: { id: t.id, title: 'Mine, refined' } });
    expect(r.isError).toBeFalsy();
    expect(await getThought(db, t.id)).toMatchObject({ title: 'Mine, refined', editedBy: 'claude-code', source: 'human' });
    await client.close();
  });

  it('returns domain errors as tool errors with the status prefix', async () => {
    const h = await createMemory(db, { projectId: 'demo', kind: 'rule', title: 'Human', body: 'b', source: 'human' });
    const client = await connect('/mcp', bearer);
    const r = await client.callTool({ name: 'deprecate', arguments: { id: h.id, reason: 'x' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('403: human-authored records are read-only for agents');
    const long = await client.callTool({
      name: 'remember', arguments: { project: 'demo', kind: 'fact', title: 'x'.repeat(121), body: 'b' },
    });
    expect(textOf(long)).toMatch(/^400: title is 121 characters/);
    await client.close();
  });

  it('rejects missing or wrong bearer tokens', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(init),
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('accepts the connector secret path and labels it claude-ai', async () => {
    const client = await connect(`/mcp/${TEST_SECRET}`);
    const r = await client.callTool({
      name: 'remember', arguments: { project: 'demo', kind: 'fact', title: 'Via claude.ai', body: 'b' },
    });
    const { id } = JSON.parse(textOf(r)) as { id: string };
    expect((await getMemory(db, id))?.agentLabel).toBe('claude-ai');
    await client.close();
    const wrong = await fetch(`${base}/mcp/${'w'.repeat(32)}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(wrong.status).toBe(404);
  });

  it('answers GET /mcp with 405 and keeps /healthz public', async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
  });

  it('answers GET on the connector path with 405, never with the 404 that logs the raw url', async () => {
    expect((await fetch(`${base}/mcp/${TEST_SECRET}`)).status).toBe(405);
    expect((await fetch(`${base}/mcp/${'w'.repeat(32)}`)).status).toBe(404);
  });
});

describe('connector secret unset', () => {
  it('the secret route does not exist at all when TABULA_CONNECTOR_SECRET is unset', async () => {
    const noSecretApp = await buildApp({ config: testConfig({ connectorSecret: undefined }), db });
    try {
      const res = await noSecretApp.inject({
        method: 'POST', url: `/mcp/${'x'.repeat(32)}`, payload: '{}', headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not found' });
    } finally {
      await noSecretApp.close();
    }
  });
});

describe('unexpected (non-domain) errors', () => {
  it('logs the real error and returns a generic message without leaking SQL', async () => {
    const throwingDb = {
      execute: () => {
        throw new Error('Failed query: SELECT p.id, p.name FROM projects p\nparams:');
      },
    } as unknown as Db;
    const lines: string[] = [];
    const app2 = await buildApp({
      config: testConfig(), db: throwingDb, logStream: { write: (msg) => void lines.push(msg) },
    });
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const base2 = `http://127.0.0.1:${(app2.server.address() as AddressInfo).port}`;
    try {
      const client = await connect('/mcp', bearer, base2);
      const r = await client.callTool({ name: 'list_projects', arguments: {} });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe('500: internal error in Tabula; retry later');
      expect(textOf(r)).not.toContain('Failed query');
      await client.close();
    } finally {
      await app2.close();
    }
    expect(lines.some((l) => l.includes('Failed query'))).toBe(true);
  });
});

describe('connector secret in logs', () => {
  it('never writes the secret to info-level logs, whatever the method or path shape', async () => {
    const lines: string[] = [];
    const prevLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    const logged = await buildApp({ config: testConfig(), db, logStream: { write: (msg) => void lines.push(msg) } });
    process.env.LOG_LEVEL = prevLevel;
    try {
      const init = {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      };
      const ok = await logged.inject({
        method: 'POST', url: `/mcp/${TEST_SECRET}`, payload: init,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      });
      expect(ok.statusCode).toBe(200);
      const probes = [
        ['POST', `/mcp/${TEST_SECRET}/`], ['GET', `/mcp/${TEST_SECRET}/`], ['PUT', `/mcp/${TEST_SECRET}`],
        ['PATCH', `/mcp/${TEST_SECRET}`], ['OPTIONS', `/mcp/${TEST_SECRET}`], ['GET', `/MCP/${TEST_SECRET}`],
      ] as const;
      for (const [method, url] of probes) {
        const r = await logged.inject(
          method === 'POST' ? { method, url, payload: '{}', headers: { 'content-type': 'application/json' } } : { method, url },
        );
        expect(r.statusCode, `${method} ${url}`).toBe(404);
        expect(r.json()).toEqual({ error: 'not found' });
      }
      expect(lines.length).toBeGreaterThan(probes.length);
      expect(lines.filter((l) => l.includes(TEST_SECRET))).toEqual([]);
    } finally {
      await logged.close();
    }
  });
});

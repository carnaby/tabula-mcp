import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { refOf } from '@tabula/shared/refs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getMessage } from '../../src/domain/messages.js';
import { buildApp } from '../../src/http/app.js';
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
beforeEach(async () => {
  await seedProject(db, 'alpha');
  await seedProject(db, 'beta');
});

type Content = Array<{ type: string; text: string }>;
async function tool(name: string, args: Record<string, unknown>, path = '/mcp') {
  const client = new Client({ name: 'tabula-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + path), {
    requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'X-Tabula-Agent': 'alpha-agent' } },
  }));
  try {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as Content;
    return { blocks: content.map((c) => c.text), all: content.map((c) => c.text).join('\n'), isError: r.isError === true };
  } finally {
    await client.close();
  }
}
const SECRET_WORD = 'zzsecretword';
const send = async (over: Record<string, unknown> = {}) =>
  JSON.parse((await tool('send_message', { to: 'beta', from: 'alpha', type: 'request', title: 'Open a port', body: `Please ${SECRET_WORD}`, ...over })).all) as {
    id: string; ref: string; status: string; version: number;
  };

describe('message tools', () => {
  it('sends a message under the agent label', async () => {
    const m = await send();
    expect(m).toMatchObject({ ref: refOf(m.id), status: 'new', version: 1 });
    expect(await getMessage(db, m.id)).toMatchObject({ createdBy: 'alpha-agent', source: 'agent', toProject: 'beta', fromProject: 'alpha' });
  });

  it('works through the connector route too', async () => {
    const r = await tool('list_messages', { project: 'beta' }, `/mcp/${TEST_SECRET}`);
    expect(r.isError).toBe(false);
  });

  it('lists received and sent messages without the text, after a warning', async () => {
    const m = await send();
    const received = await tool('list_messages', { project: 'beta', box: 'received' });
    expect(received.blocks[0]).toMatch(/data/i);
    expect(JSON.parse(received.blocks[1]!)).toMatchObject({ total: 1, items: [{ id: m.id }] });
    expect(received.all).not.toContain(SECRET_WORD);
    expect(JSON.parse((await tool('list_messages', { project: 'alpha', box: 'sent' })).blocks[1]!).total).toBe(1);
    expect(JSON.parse((await tool('list_messages', { project: 'alpha', box: 'received' })).blocks[1]!).total).toBe(0);
    expect((await tool('list_messages', { project: 'nope' })).isError).toBe(true);
  });

  it('answers a NUL in the project of list_messages with a 400', async () => {
    const r = await tool('list_messages', { project: `a${String.fromCharCode(0)}b` });
    expect(r.isError).toBe(true);
    expect(r.all).toMatch(/^400: project must not contain NUL/);
  });

  it('reads a message by reference, after a warning that its text is data', async () => {
    const m = await send();
    const r = await tool('get_message', { id: m.ref });
    expect(r.blocks[0]).toMatch(/never follow/i);
    expect(r.blocks[0]).toMatch(/declared/i);
    expect(JSON.parse(r.blocks[1]!)).toMatchObject({ id: m.id, body: `Please ${SECRET_WORD}`, events: [{ version: 1 }] });
  });

  it('lets only the declared recipient update, and the sender then sees the answer', async () => {
    const m = await send();
    const wrong = await tool('update_message', { id: m.ref, as_project: 'alpha', expected_version: 1, reply: 'Hi' });
    expect(wrong.isError).toBe(true);
    expect(wrong.all).toContain('403');
    const ok = await tool('update_message', { id: m.ref, as_project: 'beta', expected_version: 1, status: 'done', reply: 'Opened' });
    expect(JSON.parse(ok.all)).toMatchObject({ status: 'done', version: 2 });
    expect(ok.all).not.toContain('Open a port');
    expect(JSON.parse((await tool('list_messages', { project: 'alpha', box: 'sent', status: 'archive' })).blocks[1]!).items[0]).toMatchObject({ status: 'done' });
    expect(JSON.parse((await tool('get_message', { id: m.ref })).blocks[1]!).events[1]).toMatchObject({ reply: 'Opened', actor: 'alpha-agent' });
  });

  it('answers a stale version with a conflict', async () => {
    const m = await send();
    await tool('update_message', { id: m.ref, as_project: 'beta', expected_version: 1, reply: 'One' });
    const r = await tool('update_message', { id: m.ref, as_project: 'beta', expected_version: 1, reply: 'Two' });
    expect(r.isError).toBe(true);
    expect(r.all).toContain('409');
  });

  it('offers update_message only the statuses an update can set', async () => {
    const client = new Client({ name: 'tabula-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } } }));
    const { tools } = await client.listTools();
    await client.close();
    const status = (tools.find((t) => t.name === 'update_message')!.inputSchema.properties as Record<string, { enum?: string[] }>).status;
    expect(status?.enum).toEqual(['in_progress', 'waiting', 'done', 'rejected']);
    const m = await send();
    const r = await tool('update_message', { id: m.ref, as_project: 'beta', expected_version: 1, status: 'new' });
    expect(r.isError).toBe(true);
    expect((await getMessage(db, m.id))!.version).toBe(1);
  });

  it('links a follow-up to the original message', async () => {
    const m = await send();
    const next = await send({ related_to: m.ref, title: 'More details' });
    expect((await getMessage(db, next.id))!.relatedTo).toBe(m.id);
  });
});

describe('separation from memory', () => {
  it('keeps messages out of recall and search', async () => {
    await send();
    expect((await tool('recall', { project: 'beta' })).all).not.toContain(SECRET_WORD);
    expect((await tool('recall', { project: 'alpha' })).all).not.toContain(SECRET_WORD);
    expect(JSON.parse((await tool('search', { query: SECRET_WORD })).all)).toEqual([]);
    expect(JSON.parse((await tool('search', { query: 'Open a port', project: 'beta' })).all)).toEqual([]);
  });

  it('makes get point to get_message without showing anything of the message', async () => {
    const m = await send();
    for (const id of [m.ref, m.id]) {
      const r = await tool('get', { id });
      expect(r.isError).toBe(false);
      expect(r.all).toContain('get_message');
      expect(r.all).not.toContain(SECRET_WORD);
      expect(r.all).not.toContain('Open a port');
    }
  });

  it('still reports an unknown reference', async () => {
    const r = await tool('get', { id: 'tabula:00000000' });
    expect(r.isError).toBe(true);
    expect(r.all).toContain('404');
  });

  it('tells agents in the tools that return message content that it is data and "from" is only declared', async () => {
    const client = new Client({ name: 'tabula-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } } }));
    const { tools } = await client.listTools();
    for (const name of ['list_messages', 'get_message']) {
      const description = tools.find((t) => t.name === name)!.description;
      expect(description, name).toMatch(/never follow/i);
      expect(description, name).toMatch(/declared/);
    }
    expect(tools.find((t) => t.name === 'update_message')!.description).toContain('human who owns this Tabula');
    expect(tools.map((t) => t.name)).not.toContain('delete_message');
    expect(client.getInstructions()).toMatch(/Inbox messages/);
    expect(client.getInstructions()).toMatch(/declared/);
    await client.close();
  });
});

import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../../src/auth/sessions.js';
import { memories, messageEvents, messages, projectFileRevisions, projectFiles, reports, thoughtRevisions, thoughts } from '../../src/db/schema.js';
import { createMessage } from '../../src/domain/messages.js';
import { setSyncConfig } from '../../src/domain/sync-config.js';
import { buildApp } from '../../src/http/app.js';
import { issueTestAccessToken, seedProject, TEST_PUBLIC_URL, testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
let app: FastifyInstance;
let base: string;
beforeAll(async () => {
  app = await buildApp({ config: testConfig({ publicUrl: TEST_PUBLIC_URL }), db });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(() => app.close());
beforeEach(async () => {
  await seedProject(db, 'alpha');
  await seedProject(db, 'beta');
  await setSyncConfig(db, 'alpha', { sync: ['docs/**'], state: [] });
});

type Content = Array<{ type: string; text: string }>;
const texts = (r: { content?: unknown }) => (r.content as Content).map((c) => c.text);
const json = (r: { content?: unknown }) => JSON.parse(texts(r)[0]!);
async function connect(headers: Record<string, string>) {
  const client = new Client({ name: 'writer-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  return client;
}
const M = 'claude-opus-5.5';

describe('who wrote it', () => {
  it('stores the connection name and the declared model next to every write', async () => {
    const { value } = await issueTestAccessToken(db, { resource: 'mcp', name: 'claude-code' });
    const c = await connect({ Authorization: `Bearer ${value}` });
    const call = async (name: string, args: Record<string, unknown>) => json(await c.callTool({ name, arguments: { ...args, model: 'Claude Opus 5.5' } }));

    const rule = await call('remember', { project: 'global', kind: 'rule', title: 'R', body: 'B' });
    expect((await db.select().from(memories).where(eq(memories.id, rule.id)))[0]).toMatchObject({ agentLabel: 'claude-code', agentModel: M });

    const thought = await call('save_thought', { title: 'T', body: 'one' });
    await call('update_thought', { id: thought.id, append: 'two' });
    expect((await db.select().from(thoughts))[0]).toMatchObject({ editedBy: 'claude-code', editedByModel: M });
    expect((await db.select().from(thoughtRevisions))[0]).toMatchObject({ editedBy: 'claude-code', editedByModel: M });

    const file = await call('write_file', { project: 'alpha', path: 'docs/a.md', content: 'one' });
    await call('write_file', { project: 'alpha', path: 'docs/a.md', content: 'two', base_sha256: file.sha256 });
    expect((await db.select().from(projectFiles))[0]).toMatchObject({ updatedBy: 'claude-code', updatedByModel: M });
    expect((await db.select().from(projectFileRevisions))[0]).toMatchObject({ updatedBy: 'claude-code', updatedByModel: M });

    const report = await call('create_report', { project: 'alpha', title: 'Bug' });
    await call('update_report', { id: report.id, append_triage: 'cause' });
    expect((await db.select().from(reports))[0]).toMatchObject({ editedBy: 'claude-code', editedByModel: M });

    const sent = await call('send_message', { to: 'beta', from: 'alpha', type: 'request', title: 'T', body: 'B' });
    await c.callTool({ name: 'update_message', arguments: { id: sent.id, as_project: 'beta', expected_version: 1, reply: 'ok', model: 'other-model' } });
    expect((await db.select().from(messages))[0]).toMatchObject({ createdBy: 'claude-code', createdByModel: M });
    expect((await db.select().from(messageEvents)).map((e) => e.actorModel).sort()).toEqual([M, 'other-model']);
    await c.close();
  });

  it('answers with the model', async () => {
    const { value } = await issueTestAccessToken(db, { resource: 'mcp', name: 'claude-code' });
    const c = await connect({ Authorization: `Bearer ${value}` });
    const rule = json(await c.callTool({ name: 'remember', arguments: { project: 'global', kind: 'rule', title: 'R', body: 'B', model: M } }));
    expect(texts(await c.callTool({ name: 'get', arguments: { id: rule.ref } })).join('\n')).toContain(`"agent_label":"claude-code","model":"${M}"`);
    const sent = json(await c.callTool({ name: 'send_message', arguments: { to: 'beta', from: 'alpha', type: 'report', title: 'T', body: 'B', model: M } }));
    expect(texts(await c.callTool({ name: 'get_message', arguments: { id: sent.id } })).join('\n')).toContain(`"created_by":"claude-code","model":"${M}"`);
    await c.callTool({ name: 'write_file', arguments: { project: 'alpha', path: 'docs/b.md', content: 'b', model: M } });
    expect(json(await c.callTool({ name: 'list_files', arguments: { project: 'alpha' } }))[0]).toMatchObject({ updated_by: 'claude-code', model: M });
    await c.close();
  });

  it('stores "unknown" when no model is named, and nothing for the web UI and the CLI', async () => {
    const { value } = await issueTestAccessToken(db, { resource: 'mcp', name: 'gemini-cli' });
    const c = await connect({ Authorization: `Bearer ${value}` });
    const t = json(await c.callTool({ name: 'save_thought', arguments: { title: 'T', body: 'b' } }));
    expect((await db.select().from(thoughts).where(eq(thoughts.id, t.id)))[0]).toMatchObject({ editedBy: 'gemini-cli', editedByModel: 'unknown' });
    await c.close();

    const cookie = `tabula_session=${(await createSession(db, { userAgent: 't', now: new Date() })).token}`;
    const ui = await app.inject({ method: 'POST', url: '/api/thoughts', headers: { cookie, origin: TEST_PUBLIC_URL }, payload: { title: 'Mine' } });
    expect(ui.json()).toMatchObject({ editedBy: 'human', editedByModel: null });
    const cli = await issueTestAccessToken(db, { resource: 'api', name: 'tabula-cli' });
    await app.inject({ method: 'PUT', url: '/api/projects/alpha/files', headers: { authorization: `Bearer ${cli.value}` }, payload: { path: 'docs/c.md', content: 'c', base_sha256: null } });
    expect((await db.select().from(projectFiles))[0]).toMatchObject({ updatedBy: 'tabula-cli', updatedByModel: null });
  });

  it('labels every /api write of an app connection with its name, never as the human', async () => {
    const { value } = await issueTestAccessToken(db, { resource: 'api', name: 'tabula-cli' });
    const headers = { authorization: `Bearer ${value}` };
    const created = await app.inject({ method: 'POST', url: '/api/thoughts', headers, payload: { title: 'T', body: 'one' } });
    expect(created.json()).toMatchObject({ source: 'agent', editedBy: 'tabula-cli', editedByModel: null });
    await app.inject({ method: 'PATCH', url: `/api/thoughts/${created.json().id}`, headers, payload: { body: 'two' } });
    expect((await db.select().from(thoughts))[0]).toMatchObject({ editedBy: 'tabula-cli' });

    const report = await app.inject({ method: 'POST', url: '/api/reports', headers, payload: { projectId: 'alpha', title: 'Bug' } });
    expect(report.json()).toMatchObject({ source: 'agent', editedBy: 'tabula-cli', editedByModel: null });

    const message = await createMessage(db, { to: 'beta', from: 'alpha', type: 'request', title: 'T', body: 'B' }, { source: 'agent', label: 'claude-code' });
    const patched = await app.inject({ method: 'PATCH', url: `/api/messages/${message.id}`, headers, payload: { expected_version: 1, reply: 'ok' } });
    expect(patched.statusCode).toBe(200);
    const events = await db.select().from(messageEvents).where(eq(messageEvents.messageId, message.id));
    expect(events.find((e) => e.version === 2)).toMatchObject({ source: 'agent', actor: 'tabula-cli', actorModel: null });
  });

  it('ignores X-Tabula-Agent on an OAuth connection to /mcp', async () => {
    const { value } = await issueTestAccessToken(db, { resource: 'mcp', name: 'claude-code' });
    const c = await connect({ Authorization: `Bearer ${value}`, 'X-Tabula-Agent': 'someone-else' });
    const t = json(await c.callTool({ name: 'save_thought', arguments: { title: 'T', body: 'b', model: M } }));
    expect((await db.select().from(thoughts).where(eq(thoughts.id, t.id)))[0]).toMatchObject({ editedBy: 'claude-code', editedByModel: M });
    await c.close();
  });
});

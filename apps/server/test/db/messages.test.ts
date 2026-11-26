import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { messages } from '../../src/db/schema.js';
import {
  createMessage, deleteMessage, findMessageByRef, getMessage, inboxFeed, listMessageEvents, listMessageHeaders, type Message, type MessageActor,
  messageCounts, messageDetailView, messageSummaryView, pageMessages, updateMessage,
} from '../../src/domain/messages.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const editor = { source: 'agent' as const, label: 'test-agent' };
const full: MessageActor = { source: 'agent', label: 'test-agent', access: 'full' };
const narrow: MessageActor = { source: 'agent', label: 'token:reader', access: 'inbox', project: 'beta' };
const NUL = String.fromCharCode(0);

beforeEach(async () => {
  await seedProject(db, 'alpha');
  await seedProject(db, 'beta');
});

const send = (over: Partial<Parameters<typeof createMessage>[1]> = {}) =>
  createMessage(db, { to: 'beta', from: 'alpha', type: 'request', title: 'Open a port', body: 'Please open it.', ...over }, editor);
const move = (m: Message, patch: Partial<Parameters<typeof updateMessage>[2]>, actor: MessageActor = full) =>
  updateMessage(db, m.id, { expectedVersion: m.version, ...patch }, actor);

const external = (over: Partial<Parameters<typeof createMessage>[1]> = {}) =>
  createMessage(db, { to: 'beta', from: null, sender: 'claude.ai chat', type: 'request', title: 'Add a job type', body: 'Please.', ...over }, editor);
const fromAuthor = () =>
  createMessage(db, { to: 'beta', from: null, type: 'request', title: 'Renew it', body: 'By Friday.' }, { source: 'human', label: 'klara' });

describe('a message from an agent outside any project', () => {
  it('stores it without a sender project, with the description, and shows it as external via the connection', async () => {
    const m = await external();
    expect(m).toMatchObject({ fromProject: null, sender: 'claude.ai chat', source: 'agent', createdBy: 'test-agent' });
    expect(messageSummaryView(m)).toMatchObject({ from: 'external', via: 'test-agent', sender: 'claude.ai chat' });
    expect(messageDetailView(m, [])).toMatchObject({ from: 'external', via: 'test-agent', sender: 'claude.ai chat' });
    expect(messageSummaryView(await fromAuthor())).not.toHaveProperty('sender');
    expect(messageSummaryView(await send())).not.toHaveProperty('sender');
  });

  it('keeps the description on one line and within 80 characters', async () => {
    expect((await external({ sender: '  claude.ai\n\tchat  ' })).sender).toBe('claude.ai chat');
    expect((await external({ sender: '😀'.repeat(80) })).sender).toBe('😀'.repeat(80));
    // Zero-width, bidirectional and separator characters would let a description pose as another one.
    const invisible = [0x200b, 0x200e, 0x202e, 0x2066].map((c) => `claude${String.fromCharCode(c)}.ai`);
    for (const sender of ['', ' \n ', 'x'.repeat(81), `a${NUL}b`, ...invisible]) {
      await expect(external({ sender }), JSON.stringify(sender)).rejects.toMatchObject({ code: 'bad_request' });
    }
  });

  it('needs exactly one of a sender project and a description', async () => {
    await expect(send({ sender: 'claude.ai chat' })).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('not both') });
    await expect(external({ sender: undefined })).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('sender (who you are') });
    await expect(
      createMessage(db, { to: 'beta', from: null, sender: 'x', type: 'request', title: 'T', body: 'B' }, { source: 'human', label: 'klara' }),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('no sender description') });
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it('tells an agent with an unknown or global sender project how to send without one', async () => {
    await expect(send({ from: 'claude-ai-chat' })).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('leave out from and pass sender') });
    await expect(send({ from: 'global' })).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('leave out from and pass sender') });
    await expect(send({ to: 'nope' })).rejects.toMatchObject({ code: 'not_found', message: expect.not.stringContaining('pass sender') });
  });

  it('lets it wait on the author but not on the sender', async () => {
    const m = await external();
    await expect(move(m, { status: 'waiting', waitingOn: 'sender' })).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('no sender project') });
    expect(await move(m, { status: 'waiting', waitingOn: 'author' })).toMatchObject({ status: 'waiting', waitingOn: 'author', version: 2 });
  });

  it('is listed by from "external", and from "author" lists only what the owner sent', async () => {
    const ext = await external();
    const own = await fromAuthor();
    await send();
    const ids = async (from: string) => (await listMessageHeaders(db, { from, limit: 10 })).items.map((m) => m.id);
    expect(await ids('external')).toEqual([ext.id]);
    expect(await ids('author')).toEqual([own.id]);
  });
});

describe('createMessage', () => {
  it('stores the message as new with a first history entry', async () => {
    const m = await send();
    expect(m).toMatchObject({ status: 'new', version: 1, toProject: 'beta', fromProject: 'alpha', createdBy: 'test-agent', source: 'agent' });
    expect(await listMessageEvents(db, m.id)).toMatchObject([{ version: 1, fromStatus: null, toStatus: 'new', actor: 'test-agent' }]);
  });

  it('refuses unknown projects and the global project', async () => {
    await expect(send({ to: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(send({ from: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(send({ to: 'global' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(send({ from: 'global' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it.each([
    ['blank title', { title: '   ' }],
    ['blank body', { body: ' \n ' }],
    ['long title', { title: 'x'.repeat(201) }],
    ['long body', { body: 'x'.repeat(50_001) }],
    ['NUL in title', { title: `a${NUL}b` }],
    ['NUL in body', { body: `a${NUL}b` }],
    ['NUL in the recipient', { to: `a${NUL}b` }],
    ['NUL in the sender', { from: `a${NUL}b` }],
  ])('refuses %s', async (_name, over) => {
    await expect(send(over)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('links a related message by reference and refuses an unknown one', async () => {
    const first = await send();
    expect((await send({ relatedTo: `tabula:${first.id.slice(0, 8)}` })).relatedTo).toBe(first.id);
    await expect(send({ relatedTo: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('stores a message of the author without a sender project, and refuses it from an agent', async () => {
    const m = await createMessage(db, { to: 'beta', from: null, type: 'request', title: 'Renew it', body: 'By Friday.' }, { source: 'human', label: 'klara' });
    expect(m).toMatchObject({ fromProject: null, toProject: 'beta', source: 'human', createdBy: 'klara' });
    expect(messageSummaryView(m)).toMatchObject({ from: 'author', via: 'klara' });
    expect(messageSummaryView(await send())).not.toHaveProperty('via');
    await expect(createMessage(db, { to: 'beta', from: null, type: 'request', title: 'T', body: 'B' }, editor)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      db.insert(messages).values({ toProject: 'beta', fromProject: null, type: 'request', title: 'T', body: 'B', source: 'agent', createdBy: 'x' }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('refuses to let a message of the author wait on the sender, for every actor, and lets it wait on the author', async () => {
    const m = await createMessage(db, { to: 'beta', from: null, type: 'request', title: 'Renew it', body: 'By Friday.' }, { source: 'human', label: 'klara' });
    for (const actor of [full, narrow, { source: 'human', label: 'human', access: 'full' } as const]) {
      await expect(move(m, { status: 'waiting', waitingOn: 'sender' }, actor)).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('waiting_on "author"') });
    }
    expect((await getMessage(db, m.id))!.version).toBe(1);
    expect(await move(m, { status: 'waiting', waitingOn: 'author' })).toMatchObject({ status: 'waiting', waitingOn: 'author', version: 2 });
    expect(await messageCounts(db)).toEqual({ open: 1, waiting_author: 1 });
  });
});

describe('updateMessage', () => {
  it('keeps two messages of one project independent', async () => {
    const a = await send();
    const b = await send({ title: 'Second' });
    await move(a, { status: 'done' });
    expect((await getMessage(db, b.id))!.status).toBe('new');
  });

  it('records a reply and a state change in one history entry', async () => {
    const m = await move(await send(), { status: 'in_progress', reply: ' Looking. ' });
    expect(m).toMatchObject({ status: 'in_progress', version: 2 });
    expect((await listMessageEvents(db, m.id))[1]).toMatchObject({ version: 2, fromStatus: 'new', toStatus: 'in_progress', reply: 'Looking.' });
  });

  it('records a reply without a state change', async () => {
    const m = await move(await send(), { reply: 'Noted' });
    expect(m).toMatchObject({ status: 'new', version: 2 });
    expect((await listMessageEvents(db, m.id))[1]).toMatchObject({ fromStatus: null, toStatus: null, reply: 'Noted' });
  });

  it('refuses a stale version without writing history', async () => {
    const m = await send();
    await move(m, { reply: 'First' });
    await expect(move(m, { reply: 'Second' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await listMessageEvents(db, m.id)).toHaveLength(2);
  });

  it('lets exactly one of two simultaneous writers win', async () => {
    const m = await send();
    const results = await Promise.allSettled([move(m, { reply: 'One' }), move(m, { reply: 'Two' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    expect(await listMessageEvents(db, m.id)).toHaveLength(2);
  });

  it.each([
    ['nothing to write', {}],
    ['a blank reply', { reply: '   ' }],
    ['a reply with NUL', { reply: `a${NUL}b` }],
    ['a reply over the limit', { reply: 'x'.repeat(20_001) }],
    ['waiting without waiting_on', { status: 'waiting' as const }],
    ['waiting_on without waiting', { status: 'in_progress' as const, waitingOn: 'author' as const }],
    ['rejected without a reason', { status: 'rejected' as const }],
    ['a return to new', { status: 'new' as const }],
  ])('refuses %s', async (_name, patch) => {
    await expect(move(await send(), patch)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('refuses a return to new from in_progress', async () => {
    const m = await move(await send(), { status: 'in_progress' });
    await expect(move(m, { status: 'new' })).rejects.toMatchObject({ code: 'bad_request' });
    expect((await getMessage(db, m.id))!).toMatchObject({ status: 'in_progress', version: 2 });
  });

  it('follows the state table', async () => {
    let m = await move(await send(), { status: 'waiting', waitingOn: 'author' });
    expect(m).toMatchObject({ status: 'waiting', waitingOn: 'author' });
    await expect(move(m, { status: 'waiting', waitingOn: 'author' })).rejects.toMatchObject({ code: 'bad_request' });
    m = await move(m, { status: 'waiting', waitingOn: 'sender' });
    m = await move(m, { status: 'in_progress' });
    expect(m.waitingOn).toBeNull();
    await expect(move(m, { status: 'in_progress' })).rejects.toMatchObject({ code: 'bad_request' });
    m = await move(m, { status: 'rejected', reply: 'Not needed' });
    expect(m.closedAt).toBeInstanceOf(Date);
    await expect(move(m, { status: 'done' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(move(m, { reply: 'More' })).rejects.toMatchObject({ code: 'conflict' });
    m = await move(m, { status: 'in_progress' });
    expect(m.closedAt).toBeNull();
  });

  it('limits a narrow token to open messages of its project and two states', async () => {
    const m = await send();
    expect(await move(m, { status: 'in_progress' }, narrow)).toMatchObject({ status: 'in_progress', version: 2 });
    const current = (await getMessage(db, m.id))!;
    await expect(move(current, { status: 'done' }, narrow)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(move(current, { status: 'rejected', reply: 'No' }, narrow)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(move(current, { status: 'new' }, narrow)).rejects.toMatchObject({ code: 'forbidden' });
    const closed = await move(current, { status: 'done' });
    await expect(move(closed, { reply: 'Late' }, narrow)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(move(closed, { status: 'in_progress' }, narrow)).rejects.toMatchObject({ code: 'forbidden' });
    const foreign = await send({ to: 'alpha', from: 'beta' });
    await expect(move(foreign, { reply: 'Hi' }, narrow)).rejects.toMatchObject({ code: 'not_found' });
  });

  it.each([
    ['in progress', { status: 'in_progress' as const }],
    ['in progress with a reply', { status: 'in_progress' as const, reply: 'Taking it' }],
    ['waiting for the sender', { status: 'waiting' as const, waitingOn: 'sender' as const }],
  ])('does not let a narrow token move a message waiting for the author to %s', async (_name, patch) => {
    const m = await move(await send(), { status: 'waiting', waitingOn: 'author' });
    await expect(move(m, patch, narrow)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await getMessage(db, m.id)).toMatchObject({ status: 'waiting', waitingOn: 'author', version: m.version });
    expect(await listMessageEvents(db, m.id)).toHaveLength(2);
  });

  it('lets a narrow token reply to a message waiting for the author, which keeps waiting', async () => {
    const m = await move(await send(), { status: 'waiting', waitingOn: 'author' });
    expect(await move(m, { reply: 'One more detail' }, narrow)).toMatchObject({ status: 'waiting', waitingOn: 'author', version: m.version + 1 });
  });

  it('lets a narrow token move a message waiting for the sender', async () => {
    const m = await move(await send(), { status: 'waiting', waitingOn: 'sender' });
    expect(await move(m, { status: 'in_progress' }, narrow)).toMatchObject({ status: 'in_progress', waitingOn: null });
  });

  it('lets full access move a message waiting for the author', async () => {
    const m = await move(await send(), { status: 'waiting', waitingOn: 'author' });
    expect(await move(m, { status: 'in_progress' })).toMatchObject({ status: 'in_progress', waitingOn: null });
  });
});

describe('reading', () => {
  it('lists open messages by default and closed ones in the archive', async () => {
    const open = await send();
    const closed = await move(await send({ title: 'Closed' }), { status: 'done' });
    expect((await pageMessages(db, {})).items.map((m) => m.id)).toEqual([open.id]);
    expect((await pageMessages(db, { status: 'archive' })).items.map((m) => m.id)).toEqual([closed.id]);
    expect((await pageMessages(db, { status: 'all' })).total).toBe(2);
    expect((await pageMessages(db, { status: 'done' })).total).toBe(1);
  });

  it('filters by recipient, sender and type', async () => {
    const m = await send({ type: 'report' });
    await send({ to: 'alpha', from: 'beta' });
    expect((await pageMessages(db, { to: 'beta' })).items.map((x) => x.id)).toEqual([m.id]);
    expect((await pageMessages(db, { from: 'alpha' })).items.map((x) => x.id)).toEqual([m.id]);
    expect((await pageMessages(db, { type: 'report' })).items.map((x) => x.id)).toEqual([m.id]);
  });

  it('counts open messages and those waiting for the author', async () => {
    await move(await send(), { status: 'waiting', waitingOn: 'author' });
    await move(await send(), { status: 'waiting', waitingOn: 'sender' });
    await move(await send(), { status: 'done' });
    expect(await messageCounts(db)).toEqual({ open: 2, waiting_author: 1 });
  });

  it('finds a message by reference, uuid and not by the old short form', async () => {
    const m = await send();
    expect((await findMessageByRef(db, `tabula:${m.id.slice(0, 8)}`))!.id).toBe(m.id);
    expect((await findMessageByRef(db, m.id))!.id).toBe(m.id);
    expect(await findMessageByRef(db, `#${m.id.slice(0, 4)}`)).toBeUndefined();
  });

  it('feeds open messages of one project, oldest change first, and never loses a change', async () => {
    const now = new Date();
    const a = await send();
    const b = await send({ title: 'B' });
    await send({ to: 'alpha', from: 'beta' });
    const first = await inboxFeed(db, 'beta', undefined, now);
    expect(first.items.map((m) => m.id)).toEqual([a.id, b.id]);
    expect(first.truncated).toBe(false);
    expect(first.nextSince.getTime()).toBe(now.getTime() - 5000);
    // Backdated, so only the change itself can bring the message back into the feed.
    await db.update(messages).set({ updatedAt: new Date(Date.now() - 3_600_000) }).where(eq(messages.id, a.id));
    const since = new Date(Date.now() - 60_000);
    expect((await inboxFeed(db, 'beta', since)).items.map((m) => m.id)).not.toContain(a.id);
    await move((await getMessage(db, a.id))!, { reply: 'Changed' });
    expect((await inboxFeed(db, 'beta', since)).items.map((m) => m.id)).toContain(a.id);
    const none = await inboxFeed(db, 'beta', new Date(Date.now() + 60_000));
    expect(none.items).toEqual([]);
  });

  it('stops at 200 items and continues from the last one', async () => {
    await db.insert(messages).values(Array.from({ length: 201 }, (_, i) => ({
      toProject: 'beta', fromProject: 'alpha', type: 'request' as const, title: `M${i}`, body: 'Text', source: 'agent' as const, createdBy: 'test',
    })));
    const page = await inboxFeed(db, 'beta');
    expect(page.items).toHaveLength(200);
    expect(page.truncated).toBe(true);
    expect(page.nextSince.getTime()).toBe(page.items.at(-1)!.updatedAt.getTime());
  });

  it('shows exactly the agreed fields in a list item and adds the text in the detail', async () => {
    const m = await send();
    expect(Object.keys(messageSummaryView(m)).sort()).toEqual([
      'created_at', 'from', 'id', 'ref', 'related_to', 'status', 'title', 'to', 'type', 'updated_at', 'version', 'waiting_on',
    ]);
    const detail = messageDetailView(m, await listMessageEvents(db, m.id));
    expect(detail).toMatchObject({ body: 'Please open it.', created_by: 'test-agent', events: [{ version: 1, to_status: 'new' }] });
  });

  it('deletes a message and leaves a message that pointed to it', async () => {
    const first = await send();
    const second = await send({ relatedTo: first.id });
    await move(first, { reply: 'Looking' });
    await deleteMessage(db, first.id);
    expect(await getMessage(db, first.id)).toBeUndefined();
    expect(await listMessageEvents(db, first.id)).toEqual([]);
    expect(await listMessageEvents(db, second.id)).toHaveLength(1);
    expect((await getMessage(db, second.id))!.relatedTo).toBeNull();
    await expect(deleteMessage(db, first.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('listMessageHeaders', () => {
  const at = (m: Message, iso: string) => db.update(messages).set({ updatedAt: new Date(iso) }).where(eq(messages.id, m.id));

  it('lists open messages of every project, newest change first, and says when more matched', async () => {
    const a = await send({ title: 'First' });
    const b = await send({ to: 'alpha', from: 'beta', title: 'Second' });
    const c = await send({ title: 'Third' });
    await move(c, { status: 'done' });
    await at(a, '2026-11-01T10:00:00Z');
    await at(b, '2026-11-02T10:00:00Z');
    expect((await listMessageHeaders(db, { limit: 50 })).items.map((m) => m.title)).toEqual(['Second', 'First']);
    expect(await listMessageHeaders(db, { limit: 1 })).toMatchObject({ items: [{ title: 'Second' }], truncated: true });
    expect((await listMessageHeaders(db, { limit: 2 })).truncated).toBe(false);
    expect((await listMessageHeaders(db, { status: 'all', limit: 50 })).items).toHaveLength(3);
  });

  it('orders messages changed at the same moment by id', async () => {
    const a = await send({ title: 'A' });
    const b = await send({ title: 'B' });
    await at(a, '2026-11-01T10:00:00Z');
    await at(b, '2026-11-01T10:00:00Z');
    expect((await listMessageHeaders(db, { limit: 50 })).items.map((m) => m.id)).toEqual([a.id, b.id].sort());
  });

  it('filters by recipient, sender, the author as sender and who a waiting message waits on', async () => {
    await send({ title: 'alpha to beta' });
    await send({ to: 'alpha', from: 'beta', title: 'beta to alpha' });
    await createMessage(db, { to: 'beta', from: null, type: 'request', title: 'from the author', body: 'B' }, { source: 'human', label: 'klara' });
    const w = await send({ title: 'waits on the author' });
    await move(w, { status: 'waiting', waitingOn: 'author' });
    const titles = async (f: Partial<Parameters<typeof listMessageHeaders>[1]>) =>
      (await listMessageHeaders(db, { limit: 50, ...f })).items.map((m) => m.title).sort();
    expect(await titles({ to: 'alpha' })).toEqual(['beta to alpha']);
    expect(await titles({ from: 'alpha' })).toEqual(['alpha to beta', 'waits on the author']);
    expect(await titles({ from: 'author' })).toEqual(['from the author']);
    expect(await titles({ to: 'beta', from: 'author' })).toEqual(['from the author']);
    expect(await titles({ waitingOn: 'author' })).toEqual(['waits on the author']);
    expect(await titles({ waitingOn: 'sender' })).toEqual([]);
    expect(await titles({ status: 'done', waitingOn: 'author' })).toEqual([]);
  });
});

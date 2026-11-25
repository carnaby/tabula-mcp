import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { messageEvents, messages } from '../../src/db/schema.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();

beforeEach(async () => {
  await seedProject(db, 'alpha');
  await seedProject(db, 'beta');
});

const insertMessage = async (relatedTo?: string) => {
  const [m] = await db.insert(messages).values({
    toProject: 'beta', fromProject: 'alpha', type: 'request', title: 'Title', body: 'Body', source: 'agent', createdBy: 'test', relatedTo,
  }).returning();
  return m!;
};
const refused = { cause: { message: expect.stringMatching(/cannot be changed/) } };

describe('message tables', () => {
  it.each([
    ['title', sql`title = 'Other'`],
    ['body', sql`body = 'Other'`],
    ['to_project', sql`to_project = 'alpha'`],
    ['from_project', sql`from_project = 'beta'`],
    ['type', sql`type = 'report'`],
    ['source', sql`source = 'human'`],
    ['created_by', sql`created_by = 'other'`],
    ['sender', sql`sender = 'other'`],
    ['created_at', sql`created_at = now() - interval '1 day'`],
  ])('refuses a direct change of %s', async (_name, set) => {
    const m = await insertMessage();
    await expect(db.execute(sql`UPDATE messages SET ${set} WHERE id = ${m.id}`)).rejects.toMatchObject(refused);
  });

  it('allows the state to change', async () => {
    const m = await insertMessage();
    await db.update(messages).set({ status: 'in_progress', version: 2 }).where(eq(messages.id, m.id));
    const [row] = await db.select().from(messages).where(eq(messages.id, m.id));
    expect(row).toMatchObject({ status: 'in_progress', version: 2 });
  });

  it('requires waiting_on exactly in the waiting state', async () => {
    const m = await insertMessage();
    await expect(db.update(messages).set({ status: 'waiting' }).where(eq(messages.id, m.id))).rejects.toBeTruthy();
    await expect(db.update(messages).set({ waitingOn: 'author' }).where(eq(messages.id, m.id))).rejects.toBeTruthy();
    await db.update(messages).set({ status: 'waiting', waitingOn: 'author' }).where(eq(messages.id, m.id));
  });

  it('allows related_to only to become null, so deleting the related message works', async () => {
    const first = await insertMessage();
    const other = await insertMessage();
    const second = await insertMessage(first.id);
    await expect(db.execute(sql`UPDATE messages SET related_to = ${other.id} WHERE id = ${second.id}`)).rejects.toMatchObject(refused);
    await db.delete(messages).where(eq(messages.id, first.id));
    const [row] = await db.select().from(messages).where(eq(messages.id, second.id));
    expect(row!.relatedTo).toBeNull();
  });

  it('keeps history append-only, and removes it with its message', async () => {
    const m = await insertMessage();
    await db.insert(messageEvents).values({ messageId: m.id, source: 'agent', actor: 'test', version: 1, toStatus: 'new' });
    await expect(db.execute(sql`UPDATE message_events SET actor = 'other' WHERE message_id = ${m.id}`)).rejects.toMatchObject(refused);
    await expect(db.execute(sql`DELETE FROM message_events WHERE message_id = ${m.id}`)).rejects.toMatchObject(refused);
    await db.delete(messages).where(eq(messages.id, m.id));
    expect(await db.select().from(messageEvents)).toHaveLength(0);
  });

  it('allows one history entry per message version', async () => {
    const m = await insertMessage();
    const entry = { messageId: m.id, source: 'agent' as const, actor: 'test', version: 1 };
    await db.insert(messageEvents).values(entry);
    await expect(db.insert(messageEvents).values(entry)).rejects.toBeTruthy();
  });

  it('allows a sender description exactly on a message an agent sent without a project', async () => {
    const base = { toProject: 'beta', type: 'request' as const, title: 'T', body: 'B', createdBy: 'test' };
    await db.insert(messages).values({ ...base, fromProject: 'alpha', source: 'agent' });
    await db.insert(messages).values({ ...base, fromProject: null, source: 'human' });
    await db.insert(messages).values({ ...base, fromProject: null, source: 'agent', sender: 'claude.ai chat' });
    await db.insert(messages).values({ ...base, fromProject: null, source: 'agent', sender: '😀'.repeat(80) });
    for (const bad of [
      { fromProject: 'alpha', source: 'agent' as const, sender: 'x' },
      { fromProject: null, source: 'agent' as const },
      { fromProject: null, source: 'human' as const, sender: 'x' },
      { fromProject: null, source: 'agent' as const, sender: '' },
      { fromProject: null, source: 'agent' as const, sender: 'x'.repeat(81) },
    ]) {
      await expect(db.insert(messages).values({ ...base, ...bad }), JSON.stringify(bad)).rejects.toMatchObject({ cause: { code: '23514' } });
    }
  });
});

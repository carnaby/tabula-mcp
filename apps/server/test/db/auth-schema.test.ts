import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { messages, oauthClients, oauthConnections, passkeys, thoughts } from '../../src/db/schema.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();

beforeEach(async () => {
  await seedProject(db, 'alpha');
  await seedProject(db, 'beta');
});

const client = async () => (await db.insert(oauthClients).values({ clientName: 'App', redirectUris: ['https://client.example.com/cb'] }).returning())[0]!;
const connection = (clientId: string, name: string) =>
  db.insert(oauthConnections).values({ clientId, name, resource: 'mcp', scope: 'mcp', redirectUri: 'https://client.example.com/cb' }).returning();

describe('auth tables', () => {
  it('allows one live connection per name and any number of revoked ones', async () => {
    const c = await client();
    const [first] = await connection(c.id, 'claude-code');
    await expect(connection(c.id, 'claude-code')).rejects.toMatchObject({ cause: { code: '23505' } });
    await db.update(oauthConnections).set({ revokedAt: new Date() }).where(eq(oauthConnections.id, first!.id));
    await connection(c.id, 'claude-code');
    await db.update(oauthConnections).set({ revokedAt: new Date() }).where(eq(oauthConnections.name, 'claude-code'));
    await connection(c.id, 'claude-code');
    expect(await db.select().from(oauthConnections)).toHaveLength(3);
  });

  it('keeps one passkey per credential id', async () => {
    const row = { credentialId: 'cred-1', publicKey: 'pk', name: 'Laptop' };
    await db.insert(passkeys).values(row);
    await expect(db.insert(passkeys).values(row)).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('has nullable model columns next to every author column', async () => {
    const rows = await db.execute<{ table_name: string; column_name: string; is_nullable: string }>(sql`
      SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('agent_model', 'edited_by_model', 'updated_by_model', 'created_by_model', 'actor_model')
      ORDER BY table_name, column_name`);
    expect([...rows].map((r) => `${r.table_name}.${r.column_name}:${r.is_nullable}`)).toEqual([
      'memories.agent_model:YES', 'message_events.actor_model:YES', 'messages.created_by_model:YES', 'project_file_revisions.updated_by_model:YES',
      'project_files.updated_by_model:YES', 'report_attachments.created_by_model:YES', 'reports.edited_by_model:YES',
      'thought_revisions.edited_by_model:YES', 'thoughts.edited_by_model:YES',
    ]);
    const [t] = await db.insert(thoughts).values({ title: 'T', source: 'human', editedBy: 'human' }).returning();
    expect(t!.editedByModel).toBeNull();
  });

  it('refuses a change of the model of a sent message', async () => {
    const [m] = await db.insert(messages).values({
      toProject: 'beta', fromProject: 'alpha', type: 'request', title: 'T', body: 'B', source: 'agent', createdBy: 'claude-code', createdByModel: 'claude-opus-5-5',
    }).returning();
    await expect(db.execute(sql`UPDATE messages SET created_by_model = 'other' WHERE id = ${m!.id}`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/cannot be changed/) },
    });
  });
});

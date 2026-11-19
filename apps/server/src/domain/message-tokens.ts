import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { messageTokens, projects } from '../db/schema.js';
import { badRequest, conflict, notFound } from './errors.js';
import { requireProject } from './projects.js';
import { rejectNul } from './validation.js';

const PREFIX = 'tabula_inbox_';
const NAME = /^[a-z0-9-]{1,60}$/;
/** last_used_at is informative, so a poll does not need to write it every time. */
const LAST_USED_STEP_MS = 5 * 60 * 1000;

type Row = typeof messageTokens.$inferSelect;
export type InboxToken = { id: string; projectId: string; name: string };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const view = (t: Row) => ({
  id: t.id,
  project: t.projectId,
  name: t.name,
  created_at: t.createdAt.toISOString(),
  last_used_at: t.lastUsedAt?.toISOString() ?? null,
  revoked_at: t.revokedAt?.toISOString() ?? null,
});
export type MessageTokenView = ReturnType<typeof view>;

/** The only moment the value exists outside the caller's hands: it is returned once and never stored. */
export async function createMessageToken(db: Db, input: { projectId: string; name: string }): Promise<{ token: MessageTokenView; value: string }> {
  if (!NAME.test(input.name)) throw badRequest('name must be 1 to 60 lowercase letters, digits or dashes');
  rejectNul(input.projectId, 'project');
  if (input.projectId === 'global') throw badRequest('a token belongs to a project, not to "global"');
  await requireProject(db, input.projectId);
  const value = `${PREFIX}${randomBytes(32).toString('base64url')}`;
  // The history names a token, so two active tokens of one project must not share a name. An app check rather than a
  // unique index: an index could not be created where such a pair already exists. Locking the project row serializes
  // two creations for the same project.
  const row = await db.transaction(async (tx) => {
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).for('no key update');
    const [twin] = await tx
      .select({ id: messageTokens.id })
      .from(messageTokens)
      .where(and(eq(messageTokens.projectId, input.projectId), eq(messageTokens.name, input.name), isNull(messageTokens.revokedAt)));
    if (twin) throw conflict(`project "${input.projectId}" already has an active token named "${input.name}"; choose another name or revoke that token first`);
    const [inserted] = await tx.insert(messageTokens).values({ projectId: input.projectId, name: input.name, tokenSha256: sha256(value) }).returning();
    return inserted!;
  });
  return { token: view(row), value };
}

export async function listMessageTokens(db: Db): Promise<MessageTokenView[]> {
  return (await db.select().from(messageTokens).orderBy(desc(messageTokens.createdAt))).map(view);
}

/** The record stays, so the list still shows what existed and when it was last used. */
export async function revokeMessageToken(db: Db, id: string): Promise<MessageTokenView> {
  const [row] = await db
    .update(messageTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(messageTokens.id, id), isNull(messageTokens.revokedAt)))
    .returning();
  if (row) return view(row);
  const [existing] = await db.select().from(messageTokens).where(eq(messageTokens.id, id));
  if (!existing) throw notFound(`token ${id} does not exist`);
  return view(existing);
}

/** The active token with this value. Looking up its hash means the comparison reveals nothing about the value. */
export async function authenticateMessageToken(db: Db, raw: string, now = new Date()): Promise<InboxToken | undefined> {
  if (!raw.startsWith(PREFIX)) return undefined;
  const [row] = await db
    .select()
    .from(messageTokens)
    .where(and(eq(messageTokens.tokenSha256, sha256(raw)), isNull(messageTokens.revokedAt)));
  if (!row) return undefined;
  const before = new Date(now.getTime() - LAST_USED_STEP_MS);
  await db
    .update(messageTokens)
    .set({ lastUsedAt: now })
    .where(and(eq(messageTokens.id, row.id), or(isNull(messageTokens.lastUsedAt), lt(messageTokens.lastUsedAt, before))));
  return { id: row.id, projectId: row.projectId, name: row.name };
}

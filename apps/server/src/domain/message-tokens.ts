import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { messageTokens } from '../db/schema.js';
import { badRequest, notFound } from './errors.js';
import { requireProject } from './projects.js';

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
  if (input.projectId === 'global') throw badRequest('a token belongs to a project, not to "global"');
  await requireProject(db, input.projectId);
  const value = `${PREFIX}${randomBytes(32).toString('base64url')}`;
  const [row] = await db.insert(messageTokens).values({ projectId: input.projectId, name: input.name, tokenSha256: sha256(value) }).returning();
  return { token: view(row!), value };
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

import { REF_PREFIX, refOf } from '@tabula/shared/refs';
import { and, asc, count, desc, eq, gte, inArray, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { messageEvents, messages } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { parseIdRef } from './ids.js';
import { type Page, type PageQuery, pageWindow } from './paging.js';
import { requireProject } from './projects.js';
import { AUTHOR_SENDER, charCount, rejectNul } from './validation.js';

export const MESSAGE_TYPES = ['request', 'report'] as const;
export const MESSAGE_STATUSES = ['new', 'in_progress', 'waiting', 'done', 'rejected'] as const;
/** What an update can set: `new` is only where a message starts. */
export const UPDATE_STATUSES = ['in_progress', 'waiting', 'done', 'rejected'] as const;
export const OPEN_STATUSES = ['new', 'in_progress', 'waiting'] as const;
export const CLOSED_STATUSES = ['done', 'rejected'] as const;
export const WAITING_ON = ['author', 'sender'] as const;
export const MESSAGE_LIMITS = { title: 200, body: 50_000, reply: 20_000 } as const;
/** The inbox feed returns at most this many messages at once. */
const FEED_LIMIT = 200;
/** A change can commit shortly after its timestamp was taken, so the next poll looks this far back. */
const FEED_OVERLAP_MS = 5000;

export type Message = typeof messages.$inferSelect;
export type MessageEvent = typeof messageEvents.$inferSelect;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export type MessageWaitingOn = (typeof WAITING_ON)[number];
export type MessageStatusFilter = MessageStatus | 'open' | 'archive' | 'all';

/** Who changes a message. `inbox` is a narrow token, bound to the project it may read. */
export type MessageActor =
  | { source: 'agent' | 'human'; label: string; access: 'full'; model?: string | null }
  | { source: 'agent'; label: string; access: 'inbox'; project: string; model?: string | null };

export type MessagePatch = {
  /** The version the writer read; any other current version is a conflict. */
  expectedVersion: number;
  reply?: string;
  status?: MessageStatus;
  waitingOn?: MessageWaitingOn;
};

const TRANSITIONS: Record<MessageStatus, readonly MessageStatus[]> = {
  new: ['in_progress', 'waiting', 'done', 'rejected'],
  in_progress: ['waiting', 'done', 'rejected'],
  waiting: ['in_progress', 'waiting', 'done', 'rejected'],
  done: ['in_progress', 'waiting'],
  rejected: ['in_progress', 'waiting'],
};
const INBOX_TOKEN_STATUSES: readonly MessageStatus[] = ['in_progress', 'waiting'];

const isClosed = (s: MessageStatus) => (CLOSED_STATUSES as readonly MessageStatus[]).includes(s);

function checkLimit(value: string, field: 'title' | 'body' | 'reply'): void {
  rejectNul(value, field);
  const n = charCount(value);
  if (n > MESSAGE_LIMITS[field]) throw badRequest(`${field} is ${n} characters; the limit is ${MESSAGE_LIMITS[field]}`);
}

async function checkProject(db: Db, id: string, field: 'to' | 'from'): Promise<void> {
  rejectNul(id, field);
  if (id === 'global') throw badRequest(`${field} must be a project, not "global"`);
  await requireProject(db, id);
}

export async function createMessage(
  db: Db,
  input: { to: string; from: string | null; type: MessageType; title: string; body: string; relatedTo?: string },
  editor: { source: 'agent' | 'human'; label: string; model?: string | null },
): Promise<Message> {
  const title = input.title.replace(/\s+/g, ' ').trim();
  const body = input.body.trim();
  if (!title) throw badRequest('title must not be empty');
  if (!body) throw badRequest('body must not be empty');
  checkLimit(title, 'title');
  checkLimit(body, 'body');
  await checkProject(db, input.to, 'to');
  // Only the owner sends without a sender project (App API); the database refuses it for anyone else too.
  if (input.from === null) {
    if (editor.source !== 'human') throw badRequest('a message without a sender project can only come from the author');
  } else await checkProject(db, input.from, 'from');
  const relatedTo = input.relatedTo ? (await requireMessageByRef(db, input.relatedTo)).id : null;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({
        toProject: input.to, fromProject: input.from, type: input.type, title, body, relatedTo, source: editor.source, createdBy: editor.label,
        createdByModel: editor.model ?? null,
      })
      .returning();
    await tx.insert(messageEvents).values({
      messageId: row!.id, source: editor.source, actor: editor.label, actorModel: editor.model ?? null, version: 1, toStatus: 'new',
    });
    return row!;
  });
}

export async function updateMessage(db: Db, id: string, patch: MessagePatch, actor: MessageActor): Promise<Message> {
  const reply = patch.reply?.trim() || undefined;
  if (reply) checkLimit(reply, 'reply');
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(messages).where(eq(messages.id, id)).for('update');
    // For a narrow token a message of another project is the same as no message.
    if (!cur || (actor.access === 'inbox' && cur.toProject !== actor.project)) throw notFound(`message ${id} does not exist`);
    const wasClosed = isClosed(cur.status);
    if (actor.access === 'inbox') {
      if (wasClosed) throw forbidden('a closed message cannot be changed with an inbox token');
      if (patch.status && !INBOX_TOKEN_STATUSES.includes(patch.status)) throw forbidden('an inbox token can only set in_progress or waiting');
      // Only the author takes a message out of "waiting for the author"; until then a token can add a reply.
      if (patch.status && cur.status === 'waiting' && cur.waitingOn === 'author') {
        throw forbidden('an inbox token cannot change the status of a message waiting for the author');
      }
    }
    if (patch.expectedVersion !== cur.version) {
      throw conflict(`message was changed meanwhile (now version ${cur.version}, you read ${patch.expectedVersion}). Read it again.`);
    }
    if (!reply && !patch.status) throw badRequest('pass a reply, a status or both');
    if (patch.status === 'waiting' && !patch.waitingOn) throw badRequest('status waiting needs waiting_on: author or sender');
    if (patch.waitingOn && patch.status !== 'waiting') throw badRequest('waiting_on goes only with status waiting');
    // A message from the author has no sender project: waiting on the sender is waiting on the author.
    if (cur.fromProject === null && patch.waitingOn === 'sender') {
      throw badRequest('the sender of this message is the author; use waiting_on "author"');
    }
    if (patch.status === 'rejected' && !reply) throw badRequest('status rejected needs a reply with the reason');
    if (!patch.status && wasClosed) throw conflict('the message is closed; reopen it before replying');
    if (patch.status) {
      const same = patch.status === cur.status && patch.waitingOn === (cur.waitingOn ?? undefined);
      if (same || !TRANSITIONS[cur.status].includes(patch.status)) throw badRequest(`a message cannot go from ${cur.status} to ${patch.status}`);
    }
    const status = patch.status ?? cur.status;
    const waitingOn = status === 'waiting' ? (patch.waitingOn ?? cur.waitingOn) : null;
    const closedAt = isClosed(status) ? (wasClosed ? cur.closedAt : new Date()) : null;
    const version = cur.version + 1;
    const [row] = await tx.update(messages).set({ status, waitingOn, closedAt, version }).where(eq(messages.id, id)).returning();
    await tx.insert(messageEvents).values({
      messageId: id, source: actor.source, actor: actor.label, actorModel: actor.model ?? null, version, reply: reply ?? null,
      fromStatus: patch.status ? cur.status : null,
      toStatus: patch.status ?? null,
      waitingOn: patch.status === 'waiting' ? patch.waitingOn : null,
    });
    return row!;
  });
}

export async function getMessage(db: Db, id: string): Promise<Message | undefined> {
  const [row] = await db.select().from(messages).where(eq(messages.id, id));
  return row;
}

export async function requireMessage(db: Db, id: string): Promise<Message> {
  const m = await getMessage(db, id);
  if (!m) throw notFound(`message ${id} does not exist`);
  return m;
}

/** A message by reference or uuid. The old short form (#a1f3) never meant a message. */
export async function findMessageByRef(db: Db, raw: string): Promise<Message | undefined> {
  const ref = parseIdRef(raw);
  if (ref.kind === 'full') return getMessage(db, ref.id);
  if (ref.legacy) return undefined;
  const rows = await db.select().from(messages).where(sql`replace(${messages.id}::text, '-', '') LIKE ${`${ref.prefix}%`}`).limit(2);
  if (rows.length > 1) throw badRequest(`${REF_PREFIX}${ref.prefix} matches several messages; pass more characters`);
  return rows[0];
}

/** Messages whose id starts with the hex prefix (dashes ignored), at most 6, lowest ids first, like recordCandidates. */
export async function messageCandidates(db: Db, prefix: string): Promise<{ id: string; type: 'message'; title: string }[]> {
  const rows = await db
    .select({ id: messages.id, title: messages.title })
    .from(messages)
    .where(sql`replace(${messages.id}::text, '-', '') LIKE ${`${prefix}%`}`)
    .orderBy(asc(messages.id))
    .limit(6);
  return rows.map((r) => ({ ...r, type: 'message' as const }));
}

export async function requireMessageByRef(db: Db, raw: string): Promise<Message> {
  const m = await findMessageByRef(db, raw);
  if (!m) throw notFound(`no message matches ${raw}`);
  return m;
}

export const listMessageEvents = (db: Db, id: string): Promise<MessageEvent[]> =>
  db.select().from(messageEvents).where(eq(messageEvents.messageId, id)).orderBy(asc(messageEvents.version));

function statusCondition(status: MessageStatusFilter): SQL | undefined {
  if (status === 'all') return undefined;
  if (status === 'open') return inArray(messages.status, [...OPEN_STATUSES]);
  if (status === 'archive') return inArray(messages.status, [...CLOSED_STATUSES]);
  return eq(messages.status, status);
}

export async function pageMessages(
  db: Db,
  f: { to?: string; from?: string; type?: MessageType; status?: MessageStatusFilter } & Pick<PageQuery<string>, 'page' | 'pageSize'>,
): Promise<Page<Message>> {
  const { page, pageSize, limit, offset } = pageWindow(f);
  const where = and(
    f.to ? eq(messages.toProject, f.to) : undefined,
    f.from ? eq(messages.fromProject, f.from) : undefined,
    f.type ? eq(messages.type, f.type) : undefined,
    statusCondition(f.status ?? 'open'),
  );
  const [items, [total]] = await Promise.all([
    db.select().from(messages).where(where).orderBy(desc(messages.updatedAt), asc(messages.id)).limit(limit).offset(offset),
    db.select({ n: count() }).from(messages).where(where),
  ]);
  return { items, total: total?.n ?? 0, page, pageSize };
}

/** Open messages for one project, oldest change first. The caller passes `nextSince` to its next poll. */
export async function inboxFeed(
  db: Db, project: string, since?: Date, now = new Date(),
): Promise<{ items: Message[]; nextSince: Date; truncated: boolean }> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.toProject, project), statusCondition('open'), since ? gte(messages.updatedAt, since) : undefined))
    .orderBy(asc(messages.updatedAt), asc(messages.id))
    .limit(FEED_LIMIT + 1);
  const truncated = rows.length > FEED_LIMIT;
  const items = rows.slice(0, FEED_LIMIT);
  return { items, truncated, nextSince: truncated ? items.at(-1)!.updatedAt : new Date(now.getTime() - FEED_OVERLAP_MS) };
}

export async function messageCounts(db: Db): Promise<{ open: number; waiting_author: number }> {
  const [row] = await db
    .select({ open: count(), waiting: sql<number>`count(*) FILTER (WHERE ${messages.waitingOn} = 'author')`.mapWith(Number) })
    .from(messages)
    .where(statusCondition('open'));
  return { open: row?.open ?? 0, waiting_author: row?.waiting ?? 0 };
}

export async function deleteMessage(db: Db, id: string): Promise<void> {
  const gone = await db.delete(messages).where(eq(messages.id, id)).returning({ id: messages.id });
  if (gone.length === 0) throw notFound(`message ${id} does not exist`);
}

/** The sender as every reader gets it: a project, or "author" (the owner, through an app) with the app's connection name. */
export const senderView = (m: Pick<Message, 'fromProject' | 'createdBy'>): { from: string; via?: string } =>
  m.fromProject === null ? { from: AUTHOR_SENDER, via: m.createdBy } : { from: m.fromProject };

/** A message in a list: never its text. The narrow API promises exactly these fields. */
export const messageSummaryView = (m: Message) => ({
  id: m.id,
  ref: refOf(m.id),
  to: m.toProject,
  ...senderView(m),
  type: m.type,
  title: m.title,
  status: m.status,
  waiting_on: m.waitingOn,
  related_to: m.relatedTo,
  version: m.version,
  created_at: m.createdAt.toISOString(),
  updated_at: m.updatedAt.toISOString(),
});

const eventView = (e: MessageEvent) => ({
  at: e.at.toISOString(),
  actor: e.actor,
  model: e.actorModel,
  source: e.source,
  version: e.version,
  from_status: e.fromStatus,
  to_status: e.toStatus,
  waiting_on: e.waitingOn,
  reply: e.reply,
});

export const messageDetailView = (m: Message, events: MessageEvent[]) => ({
  ...messageSummaryView(m),
  body: m.body,
  source: m.source,
  created_by: m.createdBy,
  model: m.createdByModel,
  closed_at: m.closedAt?.toISOString() ?? null,
  events: events.map(eventView),
});

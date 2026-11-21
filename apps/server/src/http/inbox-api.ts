import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { notFound } from '../domain/errors.js';
import { authenticateMessageToken, type InboxToken } from '../domain/message-tokens.js';
import { getMessage, inboxFeed, listMessageEvents, messageDetailView, messageSummaryView, updateMessage } from '../domain/messages.js';
import { bearerToken } from './auth.js';
import { messagePatchBody, toMessagePatch } from './message-body.js';
import { parse } from './parse.js';

const BODY_LIMIT = 128 * 1024;
const idParams = z.object({ id: z.uuid() });
/** Bounds of `since`: some well-formed dates, such as the year 0000, make the query fail. */
const SINCE_MIN = Date.UTC(2000, 0, 1);
const SINCE_MAX = Date.UTC(2100, 0, 1);
const listQuery = z.object({
  since: z.iso
    .datetime({ offset: true })
    .refine((s) => Date.parse(s) >= SINCE_MIN && Date.parse(s) < SINCE_MAX, { error: 'since must be in the years 2000 to 2099' })
    .optional(),
});

/**
 * The API of a narrow token: the messages of one project and nothing else. It is registered next to the /api plugin, so
 * it does not inherit that plugin's full-token check, and it accepts no other credential. Every other route compares
 * against the full token or the connector secret, which is why a narrow token opens nothing there.
 */
export const inboxApiRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  const tokens = new WeakMap<FastifyRequest, InboxToken>();
  const tokenOf = (req: FastifyRequest) => tokens.get(req)!;

  // Before the body is read: only a valid token gets that far.
  app.addHook('onRequest', async (req, reply) => {
    const raw = bearerToken(req);
    const token = raw ? await authenticateMessageToken(db, raw) : undefined;
    if (!token) return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
    tokens.set(req, token);
  });

  app.get('/messages', async (req) => {
    const q = parse(listQuery, req.query);
    const feed = await inboxFeed(db, tokenOf(req).projectId, q.since ? new Date(q.since) : undefined);
    return { items: feed.items.map(messageSummaryView), next_since: feed.nextSince.toISOString(), truncated: feed.truncated };
  });

  app.get('/messages/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const m = await getMessage(db, id);
    // A message of another project is answered exactly like one that does not exist.
    if (!m || m.toProject !== tokenOf(req).projectId) throw notFound(`message ${id} does not exist`);
    return messageDetailView(m, await listMessageEvents(db, id));
  });

  app.patch('/messages/:id', { bodyLimit: BODY_LIMIT }, async (req) => {
    const { id } = parse(idParams, req.params);
    const token = tokenOf(req);
    const patch = toMessagePatch(parse(messagePatchBody, req.body));
    const m = await updateMessage(db, id, patch, { source: 'agent', label: `token:${token.name}`, access: 'inbox', project: token.projectId });
    return messageSummaryView(m);
  });
};

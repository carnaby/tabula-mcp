import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { createMessageToken, listMessageTokens, revokeMessageToken } from '../domain/message-tokens.js';
import {
  deleteMessage, listMessageEvents, MESSAGE_STATUSES, MESSAGE_TYPES, type MessageActor, messageCounts, messageDetailView, messageSummaryView,
  pageMessages, requireMessage, updateMessage,
} from '../domain/messages.js';
import { MAX_PAGE_SIZE } from '../domain/paging.js';
import { rejectNul } from '../domain/validation.js';
import { messagePatchBody, toMessagePatch } from './message-body.js';
import { parse } from './parse.js';

const HUMAN: MessageActor = { source: 'human', label: 'human', access: 'full' };
const idParams = z.object({ id: z.uuid() });

/** The Inbox for the web UI. Registered inside the /api plugin, so only the full token opens it. */
export const messageRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/messages', async (req) => {
    const q = parse(
      z.object({
        to: z.string().optional(),
        from: z.string().optional(),
        type: z.enum(MESSAGE_TYPES).optional(),
        status: z.enum([...MESSAGE_STATUSES, 'open', 'archive', 'all']).optional(),
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
      }),
      req.query,
    );
    if (q.to) rejectNul(q.to, 'to');
    if (q.from) rejectNul(q.from, 'from');
    const page = await pageMessages(db, q);
    return { ...page, items: page.items.map(messageSummaryView) };
  });

  app.get('/messages/counts', () => messageCounts(db));

  app.get('/messages/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return messageDetailView(await requireMessage(db, id), await listMessageEvents(db, id));
  });

  app.patch('/messages/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return messageSummaryView(await updateMessage(db, id, toMessagePatch(parse(messagePatchBody, req.body)), HUMAN));
  });

  app.delete('/messages/:id', async (req, reply) => {
    await deleteMessage(db, parse(idParams, req.params).id);
    return reply.code(204).send();
  });

  app.get('/message-tokens', () => listMessageTokens(db));

  app.post('/message-tokens', async (req, reply) => {
    const b = parse(z.object({ project: z.string(), name: z.string() }), req.body);
    return reply.code(201).send(await createMessageToken(db, { projectId: b.project, name: b.name }));
  });

  app.delete('/message-tokens/:id', async (req) => revokeMessageToken(db, parse(idParams, req.params).id));
};

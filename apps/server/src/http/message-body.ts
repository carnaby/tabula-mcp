import { z } from 'zod';
import { MESSAGE_STATUSES, type MessagePatch, WAITING_ON } from '../domain/messages.js';

/** Strict: a request that tries to send `title` or `body` is refused, not quietly half-applied. */
export const messagePatchBody = z.strictObject({
  expected_version: z.number().int().positive(),
  reply: z.string().optional(),
  status: z.enum(MESSAGE_STATUSES).optional(),
  waiting_on: z.enum(WAITING_ON).optional(),
});

export const toMessagePatch = (b: z.infer<typeof messagePatchBody>): MessagePatch => ({
  expectedVersion: b.expected_version,
  reply: b.reply,
  status: b.status,
  waitingOn: b.waiting_on,
});

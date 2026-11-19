import { REF_PREFIX, refOf } from '@tabula/shared/refs';
import type { Db } from '../db/client.js';
import { DomainError } from './errors.js';
import { parseIdRef } from './ids.js';
import { findMessageByRef, type Message, messageCandidates, requireMessage } from './messages.js';
import { ambiguousRef, recordCandidates, type RefTarget, refTarget, resolveRecord } from './records.js';

export type UiRefTarget = RefTarget | (Omit<RefTarget, 'type'> & { type: 'message' });

const messageTarget = (m: Message): UiRefTarget => ({ ref: refOf(m.id), type: 'message', id: m.id, project: m.toProject, title: m.title, status: m.status });

/**
 * What a reference opens in the UI. Messages are looked up only here: resolveRecord also serves the agents' `get`,
 * which must not hand out text written by another project. For a `tabula:` prefix a message is a candidate like any
 * record, so a prefix that matches a message and anything else is ambiguous. The old short form never means a message.
 */
export async function resolveForUi(db: Db, raw: string): Promise<UiRefTarget> {
  const ref = parseIdRef(raw);
  if (ref.kind === 'prefix' && !ref.legacy) {
    const list = [...(await recordCandidates(db, ref.prefix, false)), ...(await messageCandidates(db, ref.prefix))];
    if (list.length > 1) throw ambiguousRef(`${REF_PREFIX}${ref.prefix}`, list);
    if (list[0]?.type === 'message') return messageTarget(await requireMessage(db, list[0].id));
  }
  try {
    return refTarget(await resolveRecord(db, raw));
  } catch (e) {
    if (!(e instanceof DomainError) || e.code !== 'not_found') throw e;
    const m = await findMessageByRef(db, raw);
    if (!m) throw e;
    return messageTarget(m);
  }
}

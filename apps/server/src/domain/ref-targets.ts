import { refOf } from '@tabula/shared/refs';
import type { Db } from '../db/client.js';
import { DomainError } from './errors.js';
import { findMessageByRef } from './messages.js';
import { type RefTarget, refTarget, resolveRecord } from './records.js';

export type UiRefTarget = RefTarget | (Omit<RefTarget, 'type'> & { type: 'message' });

/**
 * What a reference opens in the UI. Messages are looked up only here: resolveRecord also serves the agents' `get`,
 * which must not hand out text written by another project.
 */
export async function resolveForUi(db: Db, raw: string): Promise<UiRefTarget> {
  try {
    return refTarget(await resolveRecord(db, raw));
  } catch (e) {
    if (!(e instanceof DomainError) || e.code !== 'not_found') throw e;
    const m = await findMessageByRef(db, raw);
    if (!m) throw e;
    return { ref: refOf(m.id), type: 'message', id: m.id, project: m.toProject, title: m.title, status: m.status };
  }
}

import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';

export type LegacyVia = 'token' | 'connector';
const KEYS: Record<LegacyVia, string> = { token: 'legacy_token_last_used', connector: 'connector_secret_last_used' };
const SINCE = 'legacy_tracking_since';
const WRITE_INTERVAL_MS = 60_000;

/**
 * When TABULA_TOKEN and the connector secret were last used (spec §6, step 1): the owner moves every client to OAuth
 * and waits until these stop moving before the next release removes them. At most one write a minute per kind.
 * The throttle lives in this instance (one per app), so nothing carries over between app instances.
 */
export class LegacyUse {
  private readonly written = new Map<LegacyVia, number>();

  constructor(private readonly db: Db) {}

  async record(via: LegacyVia, now = new Date()): Promise<void> {
    const last = this.written.get(via);
    if (last !== undefined && now.getTime() - last < WRITE_INTERVAL_MS) return;
    this.written.set(via, now.getTime());
    const value = { at: now.toISOString() };
    await this.db.insert(settings).values({ key: KEYS[via], value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  }
}

/** Since when uses are recorded: "not used since <date>" means something only from then on. */
export async function startLegacyTracking(db: Db, now = new Date()): Promise<void> {
  await db.insert(settings).values({ key: SINCE, value: { at: now.toISOString() } }).onConflictDoNothing({ target: settings.key });
}

export type LegacyStatus = { since: string | null; token: string | null; connector: string | null };

export async function legacyStatus(db: Db): Promise<LegacyStatus> {
  const rows = await db.select().from(settings).where(inArray(settings.key, [SINCE, KEYS.token, KEYS.connector]));
  const at = (key: string) => {
    const v = rows.find((r) => r.key === key)?.value as { at?: unknown } | undefined;
    return typeof v?.at === 'string' ? v.at : null;
  };
  return { since: at(SINCE), token: at(KEYS.token), connector: at(KEYS.connector) };
}

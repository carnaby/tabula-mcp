import type { Db } from '../db/client.js';
import { createRegistration } from './passkeys/registrations.js';
import { countPasskeys } from './passkeys/store.js';
import type { AuthSettings } from './settings.js';

/**
 * At start: without passkeys, a registration link for the first one goes to the log. The one place a link is logged
 * (spec §4.2a): single use, 15 minutes, and the log is read only by whoever runs the host.
 */
export async function announceFirstPasskey(
  db: Db, auth: AuthSettings | null, log: { info(msg: string): void; warn(msg: string): void }, now = new Date(),
): Promise<void> {
  if (!auth) {
    log.info('TABULA_PUBLIC_URL is not set: passkeys and OAuth are off; the web UI and MCP accept only TABULA_TOKEN');
    return;
  }
  if ((await countPasskeys(db)) > 0) return;
  const token = await createRegistration(db, 'link', now);
  log.warn(
    `No passkey is registered yet. Open ${auth.issuer}/passkey/register/${token} within 15 minutes to add the first one; restarting the server or running "node dist/admin.js passkey-link" prints a new link.`,
  );
}

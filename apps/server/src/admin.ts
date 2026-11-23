import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRegistration } from './auth/passkeys/registrations.js';
import { authSettings } from './auth/settings.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';

/** Commands for whoever runs the host, inside the container: `node dist/admin.js passkey-link`. */

const USAGE = 'usage: node dist/admin.js passkey-link';
type Out = (line: string) => void;

export async function runAdmin(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Out = (l) => void process.stdout.write(`${l}\n`),
  err: Out = (l) => void process.stderr.write(`${l}\n`),
): Promise<number> {
  if (argv.length !== 1 || argv[0] !== 'passkey-link') {
    err(USAGE);
    return 2;
  }
  const config = loadConfig(env);
  const auth = authSettings(config);
  const { db, close } = createDb(config.databaseUrl);
  try {
    // A recovery link too: it adds a passkey without signing in; the new link ends every earlier one.
    const token = await createRegistration(db, 'link', new Date());
    out(`${auth.issuer}/passkey/register/${token}`);
    err('Open it within 15 minutes; it works once and replaces any earlier link.');
    return 0;
  } finally {
    await close();
  }
}

function invokedDirectly(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  runAdmin(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`admin: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}

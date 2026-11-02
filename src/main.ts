import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { purgeClosedMedia } from './domain/reports.js';
import { buildApp } from './http/app.js';
import { MediaStore } from './media/store.js';

const config = loadConfig();
await runMigrations(config.databaseUrl);
const { db, close } = createDb(config.databaseUrl);
const store = new MediaStore(config.media.dir, config.media.maxBytes);
const app = await buildApp({ config, db, store });

// Video and audio of closed reports are deleted after a grace period; checked every 15 minutes.
const purge = async () => {
  try {
    const n = await purgeClosedMedia(db, store, config.media.purgeAfterHours);
    if (n > 0) app.log.info({ deleted: n }, 'deleted media of closed reports');
  } catch (e) {
    app.log.error(e);
  }
};
const purgeTimer = setInterval(purge, 15 * 60 * 1000);
void purge();

const shutdown = async () => {
  clearInterval(purgeTimer);
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });

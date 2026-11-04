import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loggableError } from './domain/errors.js';
import { expireLeases } from './domain/jobs.js';
import { purgeClosedMedia } from './domain/reports.js';
import { buildApp } from './http/app.js';
import { MediaStore } from './media/store.js';

const config = loadConfig();
await runMigrations(config.databaseUrl);
const { db, close } = createDb(config.databaseUrl);
const store = new MediaStore(config.media.dir, config.media.maxBytes);
const app = await buildApp({ config, db, store });

// Without usable media storage Tabula still runs: only bug report uploads and new frames fail (503).
const mediaProblem = await store.startup();
if (mediaProblem) {
  app.log.error(
    { dir: store.root, problem: mediaProblem },
    'MEDIA STORAGE IS NOT USABLE: uploads to bug reports will fail until the directory exists and is writable (check TABULA_MEDIA_DIR and the volume)',
  );
}

// Every 15 minutes: video and audio of closed reports are deleted after a grace period, and transcription jobs whose
// worker stopped answering are released. Each runs on its own, so one failing does not skip the other.
const purge = async () => {
  try {
    const n = await purgeClosedMedia(db, store, config.media.purgeAfterHours, new Date(), (err, id) =>
      app.log.error({ err: loggableError(err), attachment: id }, 'could not delete the media of a closed report; retrying later'),
    );
    if (n > 0) app.log.info({ deleted: n }, 'deleted media of closed reports');
  } catch (e) {
    app.log.error(loggableError(e) as Error);
  }
  try {
    const expired = await expireLeases(db);
    if (expired > 0) app.log.warn({ jobs: expired }, 'transcription jobs whose worker stopped answering were released or failed');
  } catch (e) {
    app.log.error(loggableError(e) as Error);
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

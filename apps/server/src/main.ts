import { configWarnings, loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loggableError } from './domain/errors.js';
import { purgeClosedMedia } from './domain/reports.js';
import { fornaxClient } from './fornax/client.js';
import { createFornaxSync } from './fornax/sync.js';
import { buildApp } from './http/app.js';
import { MediaStore } from './media/store.js';

const config = loadConfig();
await runMigrations(config.databaseUrl);
const { db, close } = createDb(config.databaseUrl);
const store = new MediaStore(config.media.dir, config.media.maxBytes);
const app = await buildApp({ config, db, store });
for (const line of configWarnings()) app.log.warn(line);

// Without usable media storage Tabula still runs: only report uploads and new frames fail (503).
const mediaProblem = await store.startup();
if (mediaProblem) {
  app.log.error(
    { dir: store.root, problem: mediaProblem },
    'MEDIA STORAGE IS NOT USABLE: uploads to reports will fail until the directory exists and is writable (check TABULA_MEDIA_DIR and the volume)',
  );
}

// Transcription: the sync submits recordings to Fornax and follows the jobs. It needs the media files, so it does
// not run while the storage is unusable (a missing mount must not fail every waiting recording as "deleted").
const sync =
  config.fornax && !mediaProblem
    ? createFornaxSync({ db, store, client: fornaxClient(config.fornax), log: app.log })
    : null;
if (config.fornax && mediaProblem) app.log.error('transcription is paused: Fornax is configured but the media storage is not usable');

// Every 15 minutes: video and audio of closed reports are deleted after a grace period.
const purge = async () => {
  try {
    const n = await purgeClosedMedia(db, store, config.media.purgeAfterHours, new Date(), (err, id) =>
      app.log.error({ err: loggableError(err), attachment: id }, 'could not delete the media of a closed report; retrying later'),
    );
    if (n > 0) app.log.info({ deleted: n }, 'deleted media of closed reports');
  } catch (e) {
    app.log.error(loggableError(e) as Error);
  }
};
const purgeTimer = setInterval(purge, 15 * 60 * 1000);
void purge();

const shutdown = async () => {
  clearInterval(purgeTimer);
  // The server closes and the process exits even when stopping the sync fails.
  try {
    await sync?.stop();
  } catch (e) {
    app.log.error({ err: loggableError(e) }, 'could not stop the Fornax sync cleanly');
  }
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
sync?.start();

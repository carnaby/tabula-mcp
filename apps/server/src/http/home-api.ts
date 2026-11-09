import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { dashboard } from '../domain/dashboard.js';
import { getCopyPrompt, setCopyPrompt } from '../domain/settings.js';
import { parse } from './parse.js';

/**
 * The Home page: what waits for the user, the timeline, the warnings, and the user's settings. Registered inside the
 * /api plugin, so only the user token opens it.
 */
export const homeRoutes: FastifyPluginAsync<{ db: Db; config: Config }> = async (app, { db, config }) => {
  // purge_after_hours: Mark done shows the same confirmation as the report page.
  app.get('/dashboard', async () => ({ ...(await dashboard(db)), purge_after_hours: config.media.purgeAfterHours }));

  app.get('/settings/copy-prompt', async () => ({ text: await getCopyPrompt(db) }));

  app.put('/settings/copy-prompt', async (req) => {
    const { text } = parse(z.object({ text: z.string() }), req.body);
    return { text: await setCopyPrompt(db, text) };
  });
};

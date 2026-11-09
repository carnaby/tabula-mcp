import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { ACTIVITY_TYPES, activityPage } from '../domain/activity.js';
import { dashboard } from '../domain/dashboard.js';
import { getCopyPrompt, setCopyPrompt } from '../domain/settings.js';
import { parse } from './parse.js';

/** The server's own zone, when the browser does not say its own. */
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The Home page: what waits for the user, the timeline, the warnings, and the user's settings. Registered inside the
 * /api plugin, so only the user token opens it.
 */
export const homeRoutes: FastifyPluginAsync<{ db: Db; config: Config }> = async (app, { db, config }) => {
  // purge_after_hours: Mark done shows the same confirmation as the report page.
  app.get('/dashboard', async () => ({ ...(await dashboard(db)), purge_after_hours: config.media.purgeAfterHours }));

  // The timeline: 14 days before `before` (default now) in the browser's time zone.
  app.get('/activity', (req) => {
    const q = parse(
      z.object({
        before: z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: 'must be a date and time (ISO 8601)' }).optional(),
        type: z.enum(ACTIVITY_TYPES).optional(),
        tz: z.string().max(100).optional(),
      }),
      req.query,
    );
    return activityPage(db, { before: q.before ? new Date(q.before) : undefined, type: q.type, tz: q.tz ?? SERVER_TZ });
  });

  app.get('/settings/copy-prompt', async () => ({ text: await getCopyPrompt(db) }));

  app.put('/settings/copy-prompt', async (req) => {
    const { text } = parse(z.object({ text: z.string() }), req.body);
    return { text: await setCopyPrompt(db, text) };
  });
};

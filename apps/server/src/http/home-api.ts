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
/** `before` of the timeline: an ISO date and time with Z or an offset, within a range the date arithmetic handles. */
const BEFORE_MIN = Date.UTC(2000, 0, 1);
const BEFORE_MAX = Date.UTC(2100, 0, 1);
const BEFORE_FORMAT = 'must be an ISO 8601 date and time with Z or an offset (e.g. 2026-11-09T10:00:00Z), in the years 2000 to 2099';

/**
 * The Home page: what waits for the user, the timeline, the warnings, and the user's settings. Registered inside the
 * /api plugin, so only the user token opens it.
 */
export const homeRoutes: FastifyPluginAsync<{ db: Db; config: Config }> = async (app, { db, config }) => {
  // purge_after_hours: Mark done shows the same confirmation as the report page.
  app.get('/dashboard', async () => ({ ...(await dashboard(db, new Date(), { workerEnabled: !!config.workerToken })), purge_after_hours: config.media.purgeAfterHours }));

  // The timeline: 14 days before `before` (default now) in the browser's time zone.
  app.get('/activity', (req) => {
    const q = parse(
      z.object({
        before: z.iso
          .datetime({ offset: true, error: BEFORE_FORMAT })
          .refine((s) => Date.parse(s) >= BEFORE_MIN && Date.parse(s) < BEFORE_MAX, { error: BEFORE_FORMAT })
          .optional(),
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

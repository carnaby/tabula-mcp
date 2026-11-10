import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { ACTIVITY_TYPES, activityPage, SERVER_TZ } from '../domain/activity.js';
import { dashboard } from '../domain/dashboard.js';
import { badRequest } from '../domain/errors.js';
import { getCopyPrompt, setCopyPrompt } from '../domain/settings.js';
import { parse } from './parse.js';

/** Bounds of `before` and `after`: years the date arithmetic handles. */
const BEFORE_MIN = Date.UTC(2000, 0, 1);
const BEFORE_MAX = Date.UTC(2100, 0, 1);
const isoFormat = (name: string) => `${name} must be an ISO 8601 date and time with Z or an offset (e.g. 2026-11-09T10:00:00Z), in the years 2000 to 2099`;
/** `before` and `after` of the timeline. */
const isoInstant = (name: string) =>
  z.iso
    .datetime({ offset: true, error: isoFormat(name) })
    .refine((s) => Date.parse(s) >= BEFORE_MIN && Date.parse(s) < BEFORE_MAX, { error: isoFormat(name) });

/**
 * The Home page: what waits for the user, the timeline, the warnings, and the user's settings. Registered inside the
 * /api plugin, so only the user token opens it.
 */
export const homeRoutes: FastifyPluginAsync<{ db: Db; config: Config }> = async (app, { db, config }) => {
  // purge_after_hours: Mark done shows the same confirmation as the report page. tz: the days of the projects' activity bars.
  app.get('/dashboard', async (req) => {
    const q = parse(z.object({ tz: z.string().max(100).optional() }), req.query);
    return { ...(await dashboard(db, new Date(), { workerEnabled: !!config.workerToken, tz: q.tz ?? SERVER_TZ })), purge_after_hours: config.media.purgeAfterHours };
  });

  // The timeline in the browser's time zone, at most 25 rows a page. Without `before`: yesterday and today. With it: rows
  // strictly older than `before`, at any age. With `after`: every row from then on, no limit (the first page's refresh once older pages are loaded). `next_before` is where the next page starts (null at the end).
  app.get('/activity', (req) => {
    const q = parse(
      z.object({
        before: isoInstant('before').optional(),
        after: isoInstant('after').optional(),
        type: z.enum(ACTIVITY_TYPES).optional(),
        tz: z.string().max(100).optional(),
      }),
      req.query,
    );
    if (q.before && q.after) throw badRequest('before and after cannot be used together');
    return activityPage(db, { before: q.before ? new Date(q.before) : undefined, after: q.after ? new Date(q.after) : undefined, type: q.type, tz: q.tz ?? SERVER_TZ });
  });

  app.get('/settings/copy-prompt', async () => ({ text: await getCopyPrompt(db) }));

  app.put('/settings/copy-prompt', async (req) => {
    const { text } = parse(z.object({ text: z.string() }), req.body);
    return { text: await setCopyPrompt(db, text) };
  });
};

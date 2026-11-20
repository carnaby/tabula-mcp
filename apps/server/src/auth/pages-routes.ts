import type { FastifyInstance } from 'fastify';
import { safeEqual } from '../http/auth.js';
import { type AuthContext, sameOrigin, sessionFromCookie } from './authenticate.js';
import { PASSKEY_SCRIPT } from './browser-script.js';
import { formOf, useFormBody } from './form.js';
import { messagePage, PAGES_CSS, registerPage, safeNext, sendPage, signInPage } from './pages.js';
import { createRegistration } from './passkeys/registrations.js';
import type { RegistrationLinks } from './passkeys/routes.js';
import { countPasskeys } from './passkeys/store.js';
import { deviceLabel, isFresh } from './sessions.js';
import type { AuthSettings } from './settings.js';

/** The server-rendered sign-in and passkey registration pages, and the one script and stylesheet they load. */
export async function registerAuthPages(app: FastifyInstance, ctx: AuthContext & { auth: AuthSettings; links: RegistrationLinks }): Promise<void> {
  const { db, auth, links } = ctx;
  const device = (ua: string | undefined) => deviceLabel(ua ?? '');

  app.get('/auth/passkey.js', (_req, reply) =>
    reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(PASSKEY_SCRIPT),
  );
  app.get('/auth/pages.css', (_req, reply) => reply.type('text/css; charset=utf-8').header('cache-control', 'no-cache').send(PAGES_CSS));

  app.get('/signin', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const noPasskeys = (await countPasskeys(db)) === 0;
    return sendPage(reply, 200, signInPage({ next: safeNext(q.next), reason: q.reason === 'fresh' ? 'fresh' : 'signin', noPasskeys }));
  });

  // The link's budget of failed lookups (spec §7) is the one the JSON ceremony uses: one per address for the whole app.
  app.get<{ Params: { token: string } }>('/passkey/register/:token', async (req, reply) => {
    const found = await links.find(req, req.params.token, new Date());
    if (!found.ok && found.reason === 'too_many_attempts') {
      reply.header('retry-after', '60');
      return sendPage(reply, 429, messagePage('Too many attempts', 'Wait a minute, then open the link again.'));
    }
    if (!found.ok) {
      return sendPage(reply, 400, messagePage('Link not valid', 'This registration link is invalid, used or expired. Restarting the server or running "node dist/admin.js passkey-link" prints a new one.'));
    }
    return sendPage(reply, 200, registerPage({ token: req.params.token, defaultName: device(req.headers['user-agent']), next: '/' }));
  });

  // Another passkey for a signed-in owner: a fresh passkey check first (spec §4.3), then a single-use permission.
  app.get('/passkey/add', async (req, reply) => {
    const now = new Date();
    const found = await sessionFromCookie(ctx, req, now);
    if (!found || !isFresh(found.session, now)) {
      return reply.header('cache-control', 'no-store').redirect(`/signin?next=${encodeURIComponent('/passkey/add')}&reason=fresh`, 302);
    }
    const token = await createRegistration(db, 'add', now);
    return sendPage(reply, 200, registerPage({ token, defaultName: device(req.headers['user-agent']), next: '/#/security' }));
  });

  // Step 1 only: the web app signed in with TABULA_TOKEN posts it here to add the first passkey, never another (spec §4.2, §6).
  await app.register(async (forms) => {
    useFormBody(forms);
    forms.post('/passkey/add', { bodyLimit: 8 * 1024 }, async (req, reply) => {
      if (!sameOrigin(req, auth)) return sendPage(reply, 403, messagePage('Refused', 'This form must be sent from Tabula itself.'));
      const form = formOf(req);
      const token = form && !form.repeated ? form.get('legacy_token') : undefined;
      if (!token || !safeEqual(token, ctx.config.token)) {
        return sendPage(reply, 403, messagePage('Refused', 'Sign in again and use Add passkey on the Security page.'));
      }
      await ctx.legacy.record('token');
      // Spec §4.2: the old token adds only the first passkey. Otherwise a leaked token could plant a passkey that
      // outlives it; once one exists, more come from a fresh passkey sign-in (GET above) or admin.js passkey-link.
      if ((await countPasskeys(db)) > 0) {
        return sendPage(reply, 403, messagePage('Refused', 'A passkey already exists: sign in with it and use Add passkey on the Security page.'));
      }
      const reg = await createRegistration(db, 'add', new Date());
      return sendPage(reply, 200, registerPage({ token: reg, defaultName: device(req.headers['user-agent']), next: '/#/security' }));
    });
  });
}

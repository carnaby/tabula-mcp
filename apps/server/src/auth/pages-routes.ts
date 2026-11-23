import type { FastifyInstance } from 'fastify';
import { type AuthContext, sessionFromCookie } from './authenticate.js';
import { PASSKEY_SCRIPT } from './browser-script.js';
import { messagePage, PAGES_CSS, registerPage, safeNext, sendPage, signInPage } from './pages.js';
import { createRegistration } from './passkeys/registrations.js';
import type { RegistrationLinks } from './passkeys/routes.js';
import { countPasskeys } from './passkeys/store.js';
import { deviceLabel, isFresh } from './sessions.js';

/** The server-rendered sign-in and passkey registration pages, and the one script and stylesheet they load. */
export async function registerAuthPages(app: FastifyInstance, ctx: AuthContext & { links: RegistrationLinks }): Promise<void> {
  const { db, links } = ctx;
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
    const found = await sessionFromCookie(ctx, req, reply, now);
    if (!found || !isFresh(found.session, now)) {
      return reply.header('cache-control', 'no-store').redirect(`/signin?next=${encodeURIComponent('/passkey/add')}&reason=fresh`, 302);
    }
    const token = await createRegistration(db, 'add', now);
    return sendPage(reply, 200, registerPage({ token, defaultName: device(req.headers['user-agent']), next: '/#/security' }));
  });
}

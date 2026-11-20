import type { FastifyPluginAsync } from 'fastify';
import { type AuthContext, requirePerson } from '../auth/authenticate.js';
import { clearedSessionCookie } from '../auth/cookie.js';
import { countPasskeys } from '../auth/passkeys/store.js';
import { deleteSession, isFresh } from '../auth/sessions.js';

/** Sign-in state and security settings of the web UI. Only the person: an app's OAuth token gets 403. */
export const securityRoutes: FastifyPluginAsync<{ authCtx: AuthContext }> = async (app, { authCtx }) => {
  const { db, auth } = authCtx;
  app.addHook('preHandler', requirePerson);

  app.get('/auth/me', async (req) => {
    const p = req.principal!;
    return {
      via: p.kind,
      fresh: p.kind === 'session' && isFresh(p.session, new Date()),
      passkeys: await countPasskeys(db),
      publicUrl: auth?.issuer ?? null,
    };
  });

  app.post('/auth/logout', async (req, reply) => {
    const p = req.principal!;
    if (p.kind === 'session') {
      await deleteSession(db, p.session.id);
      if (auth) reply.header('Set-Cookie', clearedSessionCookie(auth));
    }
    return reply.code(204).send();
  });
};

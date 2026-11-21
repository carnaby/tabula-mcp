import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { type AuthContext, requirePerson } from '../auth/authenticate.js';
import { clearedSessionCookie } from '../auth/cookie.js';
import { legacyStatus } from '../auth/legacy.js';
import { displayClientName } from '../auth/names.js';
import { isLoopbackRedirect } from '../auth/oauth/crypto.js';
import { findConnection, listLiveConnections, renameConnection, revokeConnection } from '../auth/oauth/store.js';
import { countPasskeys, deletePasskey, listPasskeys, renamePasskey } from '../auth/passkeys/store.js';
import { deleteSession, deviceLabel, isFresh, listSessions } from '../auth/sessions.js';
import type { AuthSettings } from '../auth/settings.js';
import { notFound } from '../domain/errors.js';
import { parse } from './parse.js';

const idParams = z.object({ id: z.uuid() });
const nameBody = z.object({ name: z.string().max(200) });
const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * Sign the browser out: the cleared cookie replaces the renewed one that authenticating this request may already have
 * set, so the browser gets one tabula_session cookie, not two. These routes set no other cookie.
 */
const clearSession = (reply: FastifyReply, auth: AuthSettings) => reply.removeHeader('set-cookie').header('Set-Cookie', clearedSessionCookie(auth));

/** Sign-in state and security settings of the web UI. Only the person: an app's OAuth token gets 403. */
export const securityRoutes: FastifyPluginAsync<{ authCtx: AuthContext }> = async (app, { authCtx }) => {
  const { db, auth, config } = authCtx;
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
      if (auth) clearSession(reply, auth);
    }
    return reply.code(204).send();
  });

  // Every list projects its fields one by one: the rows also hold hashes and keys, which never leave the server.
  app.get('/security', async (req) => {
    const p = req.principal!;
    const now = new Date();
    const current = p.kind === 'session' ? p.session.id : null;
    return {
      via: p.kind,
      fresh: p.kind === 'session' && isFresh(p.session, now),
      publicUrl: auth?.issuer ?? null,
      passkeys: (await listPasskeys(db)).map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt.toISOString(), lastUsedAt: iso(k.lastUsedAt) })),
      connections: (await listLiveConnections(db)).map((c) => ({
        id: c.id,
        name: c.name,
        app: displayClientName(c.clientName),
        target: isLoopbackRedirect(c.redirectUri) ? 'this computer' : new URL(c.redirectUri).host,
        resource: c.resource,
        createdAt: c.createdAt.toISOString(),
        lastUsedAt: iso(c.lastUsedAt),
      })),
      sessions: (await listSessions(db, now)).map((s) => ({
        id: s.id,
        device: deviceLabel(s.userAgent),
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt.toISOString(),
        current: s.id === current,
      })),
      legacy: { ...(await legacyStatus(db)), connectorConfigured: config.connectorSecret !== undefined },
    };
  });

  app.patch('/passkeys/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const k = await renamePasskey(db, id, parse(nameBody, req.body).name);
    return { id: k.id, name: k.name };
  });

  // Deleting a passkey needs a passkey check at most 5 minutes old (spec §4.3): a stolen cookie cannot remove the owner's keys.
  app.delete('/passkeys/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const p = req.principal!;
    if (p.kind !== 'session' || !isFresh(p.session, new Date())) {
      return reply.code(403).send({ error: 'fresh_auth_required', message: 'confirm with your passkey first (at most 5 minutes ago)' });
    }
    await deletePasskey(db, id);
    return reply.code(204).send();
  });

  app.patch('/connections/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const c = await renameConnection(db, id, parse(nameBody, req.body).name.trim());
    return { id: c.id, name: c.name };
  });

  // One transaction: the connection and all its tokens, refresh tokens and codes end together.
  app.post('/connections/:id/revoke', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await db.transaction(async (tx) => {
      const c = await findConnection(tx, id);
      if (!c || c.revokedAt) throw notFound(`connection ${id} does not exist`);
      await revokeConnection(tx, id, new Date());
    });
    return reply.code(204).send();
  });

  app.delete('/sessions/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    if (!(await deleteSession(db, id))) throw notFound(`session ${id} does not exist`);
    const p = req.principal!;
    if (p.kind === 'session' && p.session.id === id && auth) clearSession(reply, auth);
    return reply.code(204).send();
  });
};

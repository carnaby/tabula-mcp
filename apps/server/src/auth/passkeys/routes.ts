import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { parse } from '../../http/parse.js';
import { type AuthContext, sameOrigin, sessionFromCookie } from '../authenticate.js';
import { sessionCookie } from '../cookie.js';
import { clientKey, FixedWindows } from '../rate-limit.js';
import { createSession, deviceLabel, markVerified, SESSION_TTL_MS } from '../sessions.js';
import { loginOptions, registrationOptions, verifyLogin, verifyRegistration } from './ceremony.js';
import { findRegistration, type RegistrationKind } from './registrations.js';
import { cleanPasskeyName } from './store.js';

const MINUTE = 60_000;
/** Spec §7: failed passkey checks and registration-link attempts, per address and minute. */
const MAX_FAILURES = 10;
const MAX_LINK_FAILURES = 10;
/** Sign-in challenges per address and minute: each one is a database row until it expires. */
const MAX_LOGIN_OPTIONS = 30;

export type LinkLookup =
  | { ok: true; registration: { id: string; kind: RegistrationKind } }
  | { ok: false; reason: 'too_many_attempts' | 'link_invalid' };

/**
 * Registration links looked up by token, with the per-address limit of spec §7. Only lookups that find nothing count,
 * so the owner using a valid link is never stopped. One instance per app, shared by every route that takes a link.
 */
export class RegistrationLinks {
  private readonly failures = new FixedWindows(MINUTE);

  constructor(private readonly db: Db) {}

  async find(req: FastifyRequest, token: string, now: Date): Promise<LinkLookup> {
    const key = clientKey(req);
    if (this.failures.count(key, now.getTime()) >= MAX_LINK_FAILURES) return { ok: false, reason: 'too_many_attempts' };
    const registration = await findRegistration(this.db, token, now);
    if (registration) return { ok: true, registration };
    this.failures.add(key, now.getTime());
    return { ok: false, reason: 'link_invalid' };
  }
}

const credential = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.record(z.string(), z.unknown()),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
});
const LINK_INVALID = { error: 'link_invalid', message: 'this registration link is invalid, used or expired; ask for a new one' };
const LINK_ATTEMPTS = { error: 'too_many_requests', message: 'too many registration attempts; wait a minute' };

/** The JSON half of the passkey ceremonies; the pages and /auth/passkey.js call them (same origin only). */
export function registerPasskeyRoutes(app: FastifyInstance, ctx: AuthContext & { links: RegistrationLinks }): void {
  const { db, auth, links } = ctx;
  const failures = new FixedWindows(MINUTE);
  const loginOptionCalls = new FixedWindows(MINUTE);

  const requireOrigin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!sameOrigin(req, auth)) return reply.code(403).send({ error: 'forbidden', message: 'cross-origin request refused' });
  };
  /** The registration of the link, or undefined once the refusal was sent. */
  const findLink = async (req: FastifyRequest, reply: FastifyReply, token: string, now: Date) => {
    const found = await links.find(req, token, now);
    if (found.ok) return found.registration;
    if (found.reason === 'too_many_attempts') reply.code(429).header('retry-after', '60').send(LINK_ATTEMPTS);
    else reply.code(400).send(LINK_INVALID);
    return undefined;
  };

  /** A browser that has a session confirms it (fresh again); otherwise a new session starts. */
  const signIn = async (req: FastifyRequest, reply: FastifyReply, now: Date) => {
    const current = await sessionFromCookie(ctx, req, reply, now);
    if (current) return markVerified(db, current.session.id, now);
    const { token } = await createSession(db, { userAgent: req.headers['user-agent'], now });
    reply.header('Set-Cookie', sessionCookie(auth, token, SESSION_TTL_MS));
  };

  app.post('/auth/passkey/login/options', { onRequest: requireOrigin }, async (req, reply) => {
    const now = new Date();
    if (loginOptionCalls.add(clientKey(req), now.getTime()) > MAX_LOGIN_OPTIONS) {
      return reply.code(429).header('retry-after', '60').send({ error: 'too_many_requests', message: 'too many sign-in attempts from this address; wait a minute' });
    }
    return { options: await loginOptions(db, auth, now) };
  });

  app.post('/auth/passkey/login/verify', { onRequest: requireOrigin, bodyLimit: 16 * 1024 }, async (req, reply) => {
    const key = clientKey(req);
    const now = new Date();
    if (failures.count(key, now.getTime()) >= MAX_FAILURES) {
      return reply.code(429).header('retry-after', '60').send({ error: 'too_many_requests', message: 'too many failed sign-ins from this address; wait a minute' });
    }
    const { response } = parse(z.object({ response: credential }), req.body);
    const passkey = await verifyLogin(db, auth, response as unknown as AuthenticationResponseJSON, now);
    if (!passkey) {
      failures.add(key, now.getTime());
      return reply.code(400).send({ error: 'passkey_rejected', message: 'the passkey was not accepted; try again' });
    }
    await signIn(req, reply, now);
    return { ok: true };
  });

  app.post('/auth/passkey/register/options', { onRequest: requireOrigin }, async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().max(100) }), req.body);
    const now = new Date();
    const reg = await findLink(req, reply, token, now);
    if (!reg) return reply;
    return { options: await registrationOptions(db, auth, reg.id, now) };
  });

  app.post('/auth/passkey/register/verify', { onRequest: requireOrigin, bodyLimit: 64 * 1024 }, async (req, reply) => {
    const body = parse(z.object({ token: z.string().max(100), name: z.string().max(200), response: credential }), req.body);
    // The name is checked first, so a bad name does not use up the link.
    const name = cleanPasskeyName(body.name, deviceLabel(req.headers['user-agent'] ?? ''));
    const now = new Date();
    const reg = await findLink(req, reply, body.token, now);
    if (!reg) return reply;
    const passkey = await verifyRegistration(db, auth, { registrationId: reg.id, response: body.response as unknown as RegistrationResponseJSON, name }, now);
    if (!passkey) return reply.code(400).send({ error: 'passkey_rejected', message: 'the passkey could not be registered; try again' });
    await signIn(req, reply, now);
    return { ok: true };
  });
}

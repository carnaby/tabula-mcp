import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../../db/client.js';
import { type AuthContext, sameOrigin, sessionFromCookie } from '../authenticate.js';
import { formOf, useFormBody } from '../form.js';
import { connectionNameProblem, suggestConnectionName } from '../names.js';
import { messagePage, sendPage } from '../pages.js';
import { isFresh } from '../sessions.js';
import { type AuthSettings, type ResourceKind, resourceKindOf } from '../settings.js';
import { renderConsent } from './consent-page.js';
import { isS256Challenge, redirectMatches } from './crypto.js';
import { OFFLINE_ACCESS } from './metadata.js';
import {
  createConnection, createPending, findClient, findLiveConnectionByName, findPending, insertCode, isUniqueViolation, type OAuthClient,
  type Pending, PENDING_TTL_MS, revokeConnection, takePending,
} from './store.js';

/*
 * /oauth/authorize (spec §3.2–3.3, Limen §5): the only way to an OAuth token. GET checks the request, sends the owner
 * through a fresh passkey check if needed, stores the request as a single-use pending row and shows the consent page;
 * POST is the decision on that row. Every refusal before the decision is a 400 page, never a redirect: registration is
 * open, so answering to a registered redirect before anyone looked would make Tabula an open redirector.
 */

export const AUTHORIZE_PATH = '/oauth/authorize';
/** RFC 6749 §3.1: no parameter may appear twice. */
const ONCE = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'resource', 'scope', 'state'] as const;

const REFUSED = { title: 'Connection refused', text: 'This connection request cannot be completed: the app is not registered here, or the address it wants to return to is not the one it registered. Start the connection again in the app.' };
const INVALID_TITLE = 'Connection request not valid';
const INVALID_TEXT = 'This connection request asks for something this server does not offer. Start the connection again in the app; if this keeps happening, the app needs an update.';
const EXPIRED_TEXT = 'This request has expired or has already been answered. Start the connection again in the app.';
const BAD_DECISION_TEXT = 'Choose Allow or Deny. Go back and try again.';
const STALE_TEXT = 'Your passkey check is older than 5 minutes. Confirm with your passkey, then decide again.';

type Query = Record<string, unknown>;
type Checked = { client: OAuthClient; redirectUri: string; codeChallenge: string; resource: ResourceKind; scope: string; state: string | null };
type Check = { ok: true; request: Checked } | { ok: false; title: string; text: string };

/** The parameter; undefined when absent, null when repeated (Fastify turns a repeated key into an array). */
function param(query: Query, name: string): string | undefined | null {
  const value = query[name];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

/** A loopback URI can match textually with a port no URL has (`:99999`); such a URI is no address to send anyone to. */
function parses(uri: string): boolean {
  try {
    new URL(uri);
    return true;
  } catch {
    return false;
  }
}

/** `uri` plus parameters, its own query kept byte for byte (registered redirect URIs carry no fragment). */
function withParams(uri: string, params: Record<string, string | null>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== null) query.set(key, value);
  return `${uri}${uri.includes('?') ? '&' : '?'}${query.toString()}`;
}

/** The granted scope for a resource, or null when the request asks for anything else. Absent means the resource's own scope. */
function grantedScope(raw: string | undefined, kind: ResourceKind): string | null {
  const asked = new Set((raw ?? '').split(' ').filter(Boolean));
  for (const s of asked) if (s !== kind && s !== OFFLINE_ACCESS) return null;
  return [kind, ...(asked.has(OFFLINE_ACCESS) ? [OFFLINE_ACCESS] : [])].join(' ');
}

async function check(db: Db, auth: AuthSettings, query: Query): Promise<Check> {
  const clientId = param(query, 'client_id');
  const redirectUri = param(query, 'redirect_uri');
  const client = typeof clientId === 'string' ? await findClient(db, clientId) : undefined;
  if (!client || typeof redirectUri !== 'string' || !client.redirectUris.some((r) => redirectMatches(r, redirectUri)) || !parses(redirectUri)) {
    return { ok: false, ...REFUSED };
  }
  const fail = (error: string): Check => ({ ok: false, title: INVALID_TITLE, text: `${INVALID_TEXT} (${error})` });
  if (ONCE.some((name) => param(query, name) === null)) return fail('invalid_request');
  if (param(query, 'response_type') !== 'code') return fail('unsupported_response_type');
  const codeChallenge = param(query, 'code_challenge');
  if (typeof codeChallenge !== 'string' || param(query, 'code_challenge_method') !== 'S256' || !isS256Challenge(codeChallenge)) return fail('invalid_request');
  const rawResource = param(query, 'resource');
  // RFC 8707: a missing resource means /mcp, the main resource.
  const resource = rawResource === undefined ? 'mcp' : resourceKindOf(auth, rawResource ?? '');
  if (resource === null) return fail('invalid_target');
  const scope = grantedScope(param(query, 'scope') ?? undefined, resource);
  if (scope === null) return fail('invalid_scope');
  return { ok: true, request: { client, redirectUri, codeChallenge, resource, scope, state: param(query, 'state') ?? null } };
}

/** The authorize URL of a stored request: the way back through a fresh passkey check. */
function authorizeUrl(auth: AuthSettings, p: Pending): string {
  const q = new URLSearchParams({
    response_type: 'code', client_id: p.clientId, redirect_uri: p.redirectUri, code_challenge: p.codeChallenge, code_challenge_method: 'S256',
    resource: auth.resources[p.resource], scope: p.scope,
  });
  if (p.state !== null) q.set('state', p.state);
  return `${AUTHORIZE_PATH}?${q.toString()}`;
}

class NameTaken extends Error {}

/** Why Allow did not go through, worded for the state the box is shown in. */
const nameTakenText = (name: string, replace: boolean): string =>
  replace
    ? `A connection named "${name}" was created meanwhile. Allow again to replace it, or choose another name.`
    : `A connection named "${name}" exists already. Tick Replace to end it, or choose another name.`;

export async function registerAuthorize(app: FastifyInstance, ctx: AuthContext & { auth: AuthSettings }): Promise<void> {
  const { db, auth } = ctx;
  /** The consent page for a request; `replace` undefined means the first view, where a taken name is offered ticked. */
  const consent = async (p: Pending, client: OAuthClient | undefined, name: string, replace: boolean | undefined, error: string | null) => {
    const nameTaken = (await findLiveConnectionByName(db, name)) !== undefined;
    return renderConsent({
      pendingId: p.id, clientName: client?.clientName ?? null, redirectUri: p.redirectUri, resource: p.resource, name, nameTaken,
      replace: replace ?? nameTaken, error,
    });
  };
  const redirect = (reply: FastifyReply, location: string) => reply.header('cache-control', 'no-store').redirect(location, 302);
  const expired = (reply: FastifyReply) => sendPage(reply, 400, messagePage('Request expired', EXPIRED_TEXT));

  app.get(AUTHORIZE_PATH, async (req, reply) => {
    const checked = await check(db, auth, (req.query ?? {}) as Query);
    if (!checked.ok) return sendPage(reply, 400, messagePage(checked.title, checked.text));
    const now = new Date();
    const found = await sessionFromCookie(ctx, req, now);
    if (!found || !isFresh(found.session, now)) {
      return redirect(reply, `/signin?next=${encodeURIComponent(req.url)}&reason=${found ? 'fresh' : 'signin'}`);
    }
    const r = checked.request;
    const pending = await createPending(db, {
      clientId: r.client.id, redirectUri: r.redirectUri, codeChallenge: r.codeChallenge, resource: r.resource, scope: r.scope, state: r.state,
      expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
    });
    return sendPage(reply, 200, await consent(pending, r.client, suggestConnectionName(r.client.clientName, r.redirectUri), undefined, null));
  });

  await app.register(async (forms) => {
    useFormBody(forms);
    forms.post(AUTHORIZE_PATH, { bodyLimit: 8 * 1024 }, async (req, reply) => {
      if (!sameOrigin(req, auth)) return sendPage(reply, 403, messagePage('Refused', 'The decision must be sent from the Tabula consent page.'));
      const now = new Date();
      const found = await sessionFromCookie(ctx, req, now);
      if (!found) return sendPage(reply, 401, messagePage('Signed out', 'Sign in again, then start the connection again in the app.'));
      const form = formOf(req);
      if (!form || form.repeated) return sendPage(reply, 400, messagePage('Refused', BAD_DECISION_TEXT));
      const decision = form.get('decision');
      if (decision !== 'allow' && decision !== 'deny') return sendPage(reply, 400, messagePage('Refused', BAD_DECISION_TEXT));
      const pending = await findPending(db, form.get('pending') ?? '', now);
      if (!pending) return expired(reply);
      // Checked before the request is taken, so the owner can confirm and decide again.
      if (!isFresh(found.session, now)) {
        const href = `/signin?next=${encodeURIComponent(authorizeUrl(auth, pending))}&reason=fresh`;
        return sendPage(reply, 403, messagePage('Confirm it is you', STALE_TEXT, { href, label: 'Confirm with passkey' }));
      }
      if (decision === 'deny') {
        const taken = await takePending(db, pending.id, now);
        if (!taken) return expired(reply);
        return redirect(reply, withParams(taken.redirectUri, { error: 'access_denied', state: taken.state, iss: auth.issuer }));
      }
      const name = (form.get('name') ?? '').trim();
      // The box names the connection it replaces; a box ticked for another name than the one sent replaces nothing.
      const replace = form.get('replace') === name;
      const client = await findClient(db, pending.clientId);
      const problem = connectionNameProblem(name);
      if (problem) return sendPage(reply, 400, await consent(pending, client, name, replace, problem));
      let location: string | undefined;
      try {
        location = await db.transaction(async (tx) => {
          const taken = await takePending(tx, pending.id, now);
          if (!taken) return undefined;
          const twin = await findLiveConnectionByName(tx, name);
          if (twin && !replace) throw new NameTaken();
          if (twin) await revokeConnection(tx, twin.id, now);
          const connection = await createConnection(tx, { clientId: taken.clientId, name, resource: taken.resource, scope: taken.scope, redirectUri: taken.redirectUri });
          const code = await insertCode(tx, {
            connectionId: connection.id, redirectUri: taken.redirectUri, codeChallenge: taken.codeChallenge, resource: taken.resource, scope: taken.scope, now,
          });
          return withParams(taken.redirectUri, { code, state: taken.state, iss: auth.issuer });
        });
      } catch (e) {
        // The transaction rolled back: the request is open again and the page asks for a decision on the name.
        if (e instanceof NameTaken || isUniqueViolation(e)) {
          return sendPage(reply, 400, await consent(pending, client, name, replace, nameTakenText(name, replace)));
        }
        throw e;
      }
      if (location === undefined) return expired(reply);
      return redirect(reply, location);
    });
  });
}

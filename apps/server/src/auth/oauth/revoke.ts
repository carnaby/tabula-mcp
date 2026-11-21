import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.js';
import { formOf, useFormBody } from '../form.js';
import { FORM_BODY_LIMIT, INVALID_FORM, perAddressLimit, sendOAuthError, unreadableForm } from './errors.js';
import { revokeToken } from './tokens.js';

/** RFC 7009: the same 200 whatever the token was, so the endpoint never tells which strings were tokens. Throttled like /oauth/token. */
export async function registerRevoke(app: FastifyInstance, deps: { db: Db }): Promise<void> {
  const limit = perAddressLimit(30, 60_000, 'too many revocation requests from this address; try again in a minute');
  await app.register(async (forms) => {
    useFormBody(forms);
    forms.post('/oauth/revoke', { bodyLimit: FORM_BODY_LIMIT, onRequest: limit, errorHandler: unreadableForm }, async (req, reply) => {
      const form = formOf(req);
      const token = form?.get('token');
      if (!form || form.repeated || !token) return sendOAuthError(reply, 400, 'invalid_request', INVALID_FORM);
      const clientId = form.get('client_id');
      await revokeToken(deps.db, { token, ...(clientId === undefined ? {} : { clientId }) }, new Date());
      return reply.code(200).header('cache-control', 'no-store').send();
    });
  });
}

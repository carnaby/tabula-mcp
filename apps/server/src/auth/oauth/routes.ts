import type { FastifyInstance } from 'fastify';
import type { AuthContext } from '../authenticate.js';
import { registerAuthorize } from './authorize.js';
import { registerMetadata } from './metadata.js';
import { registerClientRegistration } from './register.js';
import { registerRevoke } from './revoke.js';
import { registerToken } from './token.js';

/** Tabula as its own OAuth 2.1 authorization server for /mcp and /api (spec §3). */
export async function registerOAuth(app: FastifyInstance, ctx: AuthContext): Promise<void> {
  registerMetadata(app, ctx.auth);
  registerClientRegistration(app, ctx.db);
  await registerAuthorize(app, ctx);
  await registerToken(app, ctx);
  await registerRevoke(app, ctx);
}

import type { FastifyInstance } from 'fastify';
import type { AuthContext } from '../authenticate.js';
import type { AuthSettings } from '../settings.js';
import { registerMetadata } from './metadata.js';
import { registerClientRegistration } from './register.js';

/** Tabula as its own OAuth 2.1 authorization server for /mcp and /api (spec §3); mounted only with TABULA_PUBLIC_URL. */
export async function registerOAuth(app: FastifyInstance, ctx: AuthContext & { auth: AuthSettings }): Promise<void> {
  registerMetadata(app, ctx.auth);
  registerClientRegistration(app, ctx.db);
}

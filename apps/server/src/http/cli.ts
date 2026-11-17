import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { CLI_FILE } from '../cli-package.js';

/** The single source of the CLI version is its VERSION line, so the served file and /cli/version cannot drift. */
export function readCliVersion(source: string): string {
  const m = /^export const VERSION = '([^']+)';\r?$/m.exec(source);
  if (!m) throw new Error('apps/cli/tabula.mjs has no VERSION constant');
  return m[1]!;
}

/** The CLI is public code from the repository, so it is served without the token. */
export function registerCliRoutes(app: FastifyInstance, file = CLI_FILE): void {
  const source = readFileSync(file, 'utf8');
  const version = readCliVersion(source);
  app.get('/cli/tabula.mjs', (_req, reply) =>
    reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(source),
  );
  app.get('/cli/version', () => ({ version }));
}

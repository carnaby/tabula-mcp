import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/** From both src/http/ and dist/http/, ../../cli is the repository's cli folder (in Docker: /app/cli). */
export const CLI_FILE = fileURLToPath(new URL('../../cli/tabula.mjs', import.meta.url));

/** The single source of the CLI version is its VERSION line, so the served file and /cli/version cannot drift. */
export function readCliVersion(source: string): string {
  const m = /^export const VERSION = '([^']+)';\r?$/m.exec(source);
  if (!m) throw new Error('cli/tabula.mjs has no VERSION constant');
  return m[1]!;
}

/** The CLI is public code from the repository, so it is served without the token. */
export function registerCliRoutes(app: FastifyInstance, file = CLI_FILE): void {
  if (!existsSync(file)) {
    app.log.warn({ file }, 'CLI file not found; /cli is not served');
    return;
  }
  const source = readFileSync(file, 'utf8');
  const version = readCliVersion(source);
  app.get('/cli/tabula.mjs', (_req, reply) =>
    reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(source),
  );
  app.get('/cli/version', () => ({ version }));
}

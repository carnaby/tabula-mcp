import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// The CLI is the workspace package @tabula/cli (apps/cli), a dependency of the server. Node resolves it the same way
// everywhere: in the workspace node_modules/@tabula/cli links to apps/cli (tsx, Vitest); in the image `pnpm deploy`
// copies its files into node_modules/@tabula/cli (see the Dockerfile).
const require = createRequire(import.meta.url);

/** The tabula command, served at /cli/tabula.mjs. */
export const CLI_FILE = require.resolve('@tabula/cli/tabula.mjs');

/** The transcriber that tabula worker setup installs next to its Python environment. */
export const TRANSCRIBE_FILE = require.resolve('@tabula/cli/transcribe.py');

/** Speaker recognition, which tabula worker setup --diarize installs next to its own Python environment. */
export const DIARIZE_FILE = require.resolve('@tabula/cli/diarize.py');

/**
 * The CLI module itself: the server reuses its glob matcher and its clock. A non-literal specifier keeps TypeScript
 * from looking for type declarations of the plain .mjs file; callers name the part they use.
 */
export async function importCli<T>(): Promise<T> {
  return (await import(pathToFileURL(CLI_FILE).href)) as T;
}

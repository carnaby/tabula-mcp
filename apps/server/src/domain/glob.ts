import { importCli } from '../cli-package.js';

/**
 * Sync patterns are evaluated by the CLI's own matcher, so the server accepts exactly the paths `tabula push` and
 * `tabula pull` sync. The CLI is the workspace package @tabula/cli (see cli-package.ts).
 */
type CliGlob = { matchesAny(path: string, patterns: string[]): boolean };

const cli = await importCli<CliGlob>();

export function matchesSyncPattern(path: string, patterns: readonly string[]): boolean {
  return cli.matchesAny(path, [...patterns]);
}

/**
 * Sync patterns are evaluated by the CLI's own matcher, so the server accepts exactly the paths `tabula push` and
 * `tabula pull` sync. ../../cli is the repository's cli folder from both src/domain and dist/domain (in Docker: /app/cli).
 */
type CliGlob = { matchesAny(path: string, patterns: string[]): boolean };

// A non-literal specifier keeps TypeScript from looking for type declarations of the plain .mjs file.
const cli = (await import(new URL('../../cli/tabula.mjs', import.meta.url).href)) as CliGlob;

export function matchesSyncPattern(path: string, patterns: readonly string[]): boolean {
  return cli.matchesAny(path, [...patterns]);
}

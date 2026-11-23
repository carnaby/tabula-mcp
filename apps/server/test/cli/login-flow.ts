import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { seedProject } from '../helpers.js';
import { pendingOf, signedInCookie, useAuthServer } from '../oauth-flow.js';
import { makeRepo, spawnCli, tempDir } from './harness.js';

/** `tabula login` through the browser against a real OAuth server, for the CLI tests. */

/** The CLI's environment: its own home, no browser opened. */
export const env = (home: string) => ({ TABULA_HOME: home, TABULA_URL: undefined, TABULA_NO_BROWSER: '1' });
export const configOf = (home: string) => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
/** Rewrites the saved config.json with `change`. */
export const rewrite = (home: string, change: (c: any) => any) => writeFileSync(join(home, 'config.json'), JSON.stringify(change(configOf(home))));

/**
 * A server with OAuth on, and logins to it. Every login registers a client: /oauth/register allows 10 per address and hour
 * per server, so one server takes at most 10 logins.
 */
export function useLoginServer(db: Db) {
  const server = useAuthServer(db);

  /** The browser's part: the owner, signed in, decides on the consent page; the redirect reaches the CLI's loopback server. */
  async function decideInBrowser(authorizeUrl: string, decision: 'allow' | 'deny') {
    const cookie = await signedInCookie(db);
    const page = await fetch(authorizeUrl, { headers: { cookie }, redirect: 'manual' });
    expect(page.status).toBe(200);
    const decided = await fetch(`${server.url}/oauth/authorize`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pending: pendingOf(await page.text()), decision, name: 'tabula-cli', replace: 'on' }),
    });
    expect(decided.status).toBe(302);
    await fetch(decided.headers.get('location')!);
  }

  async function login(home: string, cwd: string, decision: 'allow' | 'deny' = 'allow') {
    const cli = spawnCli(['login', server.url], { cwd, env: env(home) });
    try {
      const [, url] = await cli.waitFor(/^ {2}(http\S+\/oauth\/authorize\?\S+)$/m);
      await decideInBrowser(url!, decision);
    } catch (e) {
      cli.kill(); // a CLI left waiting for the browser would outlive the test
      throw e;
    }
    return cli.done;
  }

  async function setup() {
    const home = tempDir('tabula-login-');
    await seedProject(db, 'demo');
    const repo = makeRepo(join(home, 'demo'), { sync: ['docs/**'] }, { 'docs/a.md': '# A\n' });
    return { home, repo };
  }

  return { server, login, setup, decideInBrowser };
}

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { revokeConnection } from '../../src/auth/oauth/store.js';
import { oauthConnections, oauthRefreshTokens, projectFiles } from '../../src/db/schema.js';
import { seedProject, TEST_TOKEN, useTestDb } from '../helpers.js';
import { pendingOf, signedInCookie, useAuthServer } from '../oauth-flow.js';
import { makeRepo, type RunResult, runCli, spawnCli, tempDir } from './harness.js';

const db = useTestDb();
const server = useAuthServer(db);
const env = (home: string) => ({ TABULA_HOME: home, TABULA_URL: undefined, TABULA_TOKEN: undefined, TABULA_NO_BROWSER: '1' });
const configOf = (home: string) => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
const expireAccess = (home: string) => {
  const c = configOf(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ ...c, oauth: { ...c.oauth, expires_at: 0 } }));
};

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
  const [, url] = await cli.waitFor(/^ {2}(http\S+\/oauth\/authorize\?\S+)$/m);
  await decideInBrowser(url!, decision);
  return cli.done;
}

async function setup() {
  const home = tempDir('tabula-login-');
  await seedProject(db, 'demo');
  const repo = makeRepo(join(home, 'demo'), { sync: ['docs/**'] }, { 'docs/a.md': '# A\n' });
  return { home, repo };
}

/** Sessions of this database that wait for a row lock. */
async function lockWaiters(): Promise<number> {
  const [row] = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return row!.n;
}

describe('tabula login through the browser', { timeout: 60_000 }, () => {
  it('saves the client and its tokens, never a shared token, and writes under the connection name', async () => {
    const { home, repo } = await setup();
    const r = await login(home, repo);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Logged in to ${server.url}`);
    expect(configOf(home)).toEqual({
      url: server.url,
      oauth: { client_id: expect.any(String), refresh_token: expect.any(String), access_token: expect.any(String), expires_at: expect.any(Number) },
    });
    const { oauth } = configOf(home);
    for (const secret of [oauth.access_token, oauth.refresh_token]) expect(r.stdout + r.stderr).not.toContain(secret);
    if (process.platform !== 'win32') expect(statSync(join(home, 'config.json')).mode & 0o777).toBe(0o600);
    expect((await db.select().from(oauthConnections))[0]).toMatchObject({ name: 'tabula-cli', resource: 'api', revokedAt: null });
    const push = await runCli(['push'], { cwd: repo, env: env(home) });
    expect(push.code, push.stderr).toBe(0);
    expect((await db.select().from(projectFiles))[0]).toMatchObject({ path: 'docs/a.md', updatedBy: 'tabula-cli', updatedByModel: null });
  });

  it('refreshes an expired access token and keeps the rotated pair', async () => {
    const { home, repo } = await setup();
    expect((await login(home, repo)).code).toBe(0);
    const before = configOf(home);
    expireAccess(home);
    const status = await runCli(['status'], { cwd: repo, env: env(home) });
    expect(status.code, status.stderr).toBe(0);
    const after = configOf(home);
    expect(after.oauth.refresh_token).not.toBe(before.oauth.refresh_token);
    expect(after.oauth.expires_at).toBeGreaterThan(Date.now());
    expect(status.stdout + status.stderr).not.toContain(after.oauth.refresh_token);
  });

  it('two commands refreshing at once both succeed and the connection lives on', async () => {
    const { home, repo } = await setup();
    expect((await login(home, repo)).code).toBe(0);
    expireAccess(home);
    const [a, b] = await Promise.all([runCli(['status'], { cwd: repo, env: env(home) }), runCli(['status'], { cwd: repo, env: env(home) })]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    expect((await db.select().from(oauthConnections)).filter((c) => c.revokedAt === null)).toHaveLength(1);
  });

  it('the command that loses the race to rotate takes over the pair the other one saved', async () => {
    const { home, repo } = await setup();
    expect((await login(home, repo)).code).toBe(0);
    expireAccess(home);
    // Both refreshes with the same token wait on its row; once released, one rotates and the other is refused.
    let runs: Promise<[RunResult, RunResult]> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT hash FROM oauth_refresh_tokens FOR UPDATE`);
      runs = Promise.all([runCli(['status'], { cwd: repo, env: env(home) }), runCli(['status'], { cwd: repo, env: env(home) })]);
      while ((await lockWaiters()) < 2) await new Promise((r) => setTimeout(r, 50));
    });
    const [a, b] = await runs!;
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    expect((await db.select().from(oauthConnections)).filter((c) => c.revokedAt === null)).toHaveLength(1);
    // One rotation: the loser used the winner's fresh access token instead of rotating again.
    const tokens = await db.select().from(oauthRefreshTokens);
    expect(tokens.filter((t) => t.replacedAt !== null)).toHaveLength(1);
    expect(tokens).toHaveLength(2);
  });

  it('asks to log in again once the connection is revoked', async () => {
    const { home, repo } = await setup();
    expect((await login(home, repo)).code).toBe(0);
    const [conn] = await db.select().from(oauthConnections);
    await revokeConnection(db, conn!.id, new Date());
    const live = await runCli(['status'], { cwd: repo, env: env(home) });
    expect(live.code).toBe(1);
    expect(live.stderr).toMatch(/run tabula login/);
    expireAccess(home);
    const refreshing = await runCli(['status'], { cwd: repo, env: env(home) });
    expect(refreshing.code).toBe(1);
    expect(refreshing.stderr).toMatch(/run tabula login/);
  });

  it('stops when the owner denies the connection', async () => {
    const { home, repo } = await setup();
    const r = await login(home, repo, 'deny');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/denied/);
  });

  it('never sends the saved login to another server named in TABULA_URL', async () => {
    const { home, repo } = await setup();
    expect((await login(home, repo)).code).toBe(0);
    const other = await runCli(['status'], { cwd: repo, env: { ...env(home), TABULA_URL: 'http://127.0.0.1:9' } });
    expect(other.code).toBe(1);
    expect(other.stderr).toMatch(/not logged in/);
  });

  it('--token-stdin still saves the legacy token, which replaces the OAuth login and keeps working', async () => {
    const { home, repo } = await setup();
    expect((await login(home, repo)).code).toBe(0);
    const legacy = await runCli(['login', server.url, '--token-stdin'], { cwd: repo, env: env(home), input: `${TEST_TOKEN}\n` });
    expect(legacy.code, legacy.stderr).toBe(0);
    expect(configOf(home)).toEqual({ url: server.url, token: TEST_TOKEN });
    const push = await runCli(['push'], { cwd: repo, env: env(home) });
    expect(push.code, push.stderr).toBe(0);
  });
});

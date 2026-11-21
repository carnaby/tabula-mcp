import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { oauthClients, oauthRefreshTokens } from '../../src/db/schema.js';
import { useTestDb } from '../helpers.js';
import { readText, runCli, spawnCli, startProxy } from './harness.js';
import { configOf, env, rewrite, useLoginServer } from './login-flow.js';

const db = useTestDb();
// Its own server: login.test.ts uses up most of the ten client registrations one server allows per address and hour.
const { server, login, setup, decideInBrowser } = useLoginServer(db);

/** Starts `tabula login` and returns the authorize URL it printed; the CLI keeps waiting for the browser's answer. */
async function startLogin(home: string, cwd: string, extraEnv: Record<string, string> = {}) {
  const cli = spawnCli(['login', server.url], { cwd, env: { ...env(home), ...extraEnv } });
  try {
    const [, printed] = await cli.waitFor(/^ {2}(http\S+\/oauth\/authorize\?\S+)$/m);
    return { cli, authorize: new URL(printed!) };
  } catch (e) {
    cli.kill(); // a CLI left waiting for the browser would outlive the test
    throw e;
  }
}
/** The CLI's loopback address with these query parameters. */
const callbackOf = (authorize: URL, params: Record<string, string>) => {
  const u = new URL(authorize.searchParams.get('redirect_uri')!);
  u.search = new URLSearchParams(params).toString();
  return u;
};
/** The CLI's result, or a failure (and the CLI killed) after `ms`. */
async function within(cli: ReturnType<typeof spawnCli>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => (cli.kill(), reject(new Error(`the CLI did not finish within ${ms} ms`))), ms);
  });
  try {
    return await Promise.race([cli.done, late]);
  } finally {
    clearTimeout(timer);
  }
}

describe('tabula login renewal', { timeout: 60_000 }, () => {
  it('renews at the token endpoint the server advertised', async () => {
    const { home, repo } = await setup();
    expect((await login(home, repo)).code).toBe(0);
    const seen: string[] = [];
    const proxy = await startProxy(server.url, (url) => (seen.push(url), 0));
    try {
      rewrite(home, (c) => ({ ...c, oauth: { ...c.oauth, expires_at: 0, token_endpoint: `${proxy.url}/oauth/token` } }));
      const status = await runCli(['status'], { cwd: repo, env: env(home) });
      expect(status.code, status.stderr).toBe(0);
      expect(seen).toEqual(['/oauth/token']);
    } finally {
      proxy.close();
    }
  });

  it('an older login without token_endpoint still renews', async () => {
    const { home, repo } = await setup();
    expect((await login(home, repo)).code).toBe(0);
    rewrite(home, ({ oauth: { token_endpoint: _gone, ...oauth }, ...c }) => ({ ...c, oauth: { ...oauth, expires_at: 0 } }));
    const status = await runCli(['status'], { cwd: repo, env: env(home) });
    expect(status.code, status.stderr).toBe(0);
    expect(configOf(home).oauth.expires_at).toBeGreaterThan(Date.now());
  });

  it.each([503, 429])('a %i while renewing is a server that is busy, not a login that ended', async (code) => {
    const { home, repo } = await setup();
    expect((await login(home, repo)).code).toBe(0);
    const proxy = await startProxy(server.url, () => ({ status: code }));
    try {
      rewrite(home, (c) => ({ ...c, oauth: { ...c.oauth, expires_at: 0, token_endpoint: `${proxy.url}/oauth/token` } }));
      const before = configOf(home).oauth.refresh_token;
      const status = await runCli(['status'], { cwd: repo, env: env(home) });
      expect(status.code).toBe(1);
      expect(status.stderr).toContain(`HTTP ${code}`);
      expect(status.stderr).not.toMatch(/tabula login|expired|revoked/);
      expect(configOf(home).oauth.refresh_token).toBe(before);
    } finally {
      proxy.close();
    }
  });

  it('the hook near its deadline uses an access token that outlives it instead of stopping', async () => {
    const { home, repo } = await setup();
    expect((await login(home, repo)).code).toBe(0);
    const push = await runCli(['push'], { cwd: repo, env: env(home) });
    expect(push.code, push.stderr).toBe(0);
    rmSync(join(repo, 'docs', 'a.md'));
    // Inside the 60 s renewal margin, but valid well past the hook's deadline.
    rewrite(home, (c) => ({ ...c, oauth: { ...c.oauth, expires_at: Date.now() + 30_000 } }));
    // Under RENEW_FLOOR_MS (2 s) by the time the hook asks for a bearer.
    const hook = await runCli(['pull', '--hook'], { cwd: repo, env: { ...env(home), TABULA_HOOK_DEADLINE_MS: '1900' } });
    expect(hook.code).toBe(0);
    expect(hook.stdout + hook.stderr).not.toMatch(/too little time left|timed out| of \d+ files/);
    expect(readText(repo, 'docs/a.md')).toBe('# A\n');
    expect(await db.select().from(oauthRefreshTokens)).toHaveLength(1);
  });
});

describe('tabula login checks', { timeout: 60_000 }, () => {
  it('turns away an answer with another state and keeps waiting for the real one', async () => {
    const { home, repo } = await setup();
    const { cli, authorize } = await startLogin(home, repo);
    const stray = await fetch(callbackOf(authorize, { code: 'x', state: 'not-this-login', iss: server.url }));
    expect(stray.status).toBe(400);
    expect(await stray.text()).toMatch(/another tabula login/);
    await decideInBrowser(authorize.href, 'allow');
    const r = await within(cli, 30_000);
    expect(r.code, r.stderr).toBe(0);
  });

  it('refuses an answer that names another server and saves nothing', async () => {
    const { home, repo } = await setup();
    const { cli, authorize } = await startLogin(home, repo);
    await fetch(callbackOf(authorize, { code: 'x', state: authorize.searchParams.get('state')!, iss: 'https://evil.example' }));
    const r = await within(cli, 30_000);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/another server/);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  it('gives up when the browser never answers', async () => {
    const { home, repo } = await setup();
    // Long enough to register and print the address first: the wait starts before both.
    const { cli } = await startLogin(home, repo, { TABULA_LOGIN_TIMEOUT_MS: '3000' });
    const r = await within(cli, 30_000);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no answer from the browser/);
  });

  it('refuses a server whose metadata names another address, before registering', async () => {
    const proxy = await startProxy(server.url, () => 0);
    try {
      const { home, repo } = await setup();
      const cli = spawnCli(['login', proxy.url], { cwd: repo, env: env(home) });
      const r = await within(cli, 30_000);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`tabula login ${server.url}`);
      expect(await db.select().from(oauthClients)).toHaveLength(0);
    } finally {
      proxy.close();
    }
  });

  it('names no address it cannot print, before registering', async () => {
    const real = (await (await fetch(`${server.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    // Built at runtime: the source file holds no control character.
    const issuer = `https://other.example/${String.fromCharCode(7)}x`;
    const metadata = JSON.stringify({ ...real, issuer });
    const proxy = await startProxy(server.url, (url) => (url.startsWith('/.well-known/oauth-authorization-server') ? { status: 200, body: metadata } : 0));
    try {
      const { home, repo } = await setup();
      const cli = spawnCli(['login', proxy.url], { cwd: repo, env: env(home) });
      const r = await within(cli, 30_000);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`${proxy.url} names a different address than the one you typed; log in at the address its owner gives you`);
      expect([...r.stdout + r.stderr].map((ch) => ch.charCodeAt(0)).filter((c) => c < 32 && c !== 10 && c !== 13)).toEqual([]);
      expect(await db.select().from(oauthClients)).toHaveLength(0);
    } finally {
      proxy.close();
    }
  });
});

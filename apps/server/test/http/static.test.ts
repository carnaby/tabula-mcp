import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { testConfig, useTestDb } from '../helpers.js';

const db = useTestDb();

describe('static UI', () => {
  it('serves index.html from webDist without auth', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabula-web-'));
    writeFileSync(join(dir, 'index.html'), '<title>Tabula</title>');
    const app = await buildApp({ config: testConfig({ webDist: dir }), db });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>Tabula</title>');
    await app.close();
  });

  it('starts without a web build', async () => {
    const app = await buildApp({ config: testConfig(), db });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await app.close();
  });

  it('warns about a missing web build, and not when the UI is off on purpose', async () => {
    const logsOf = async (webDist: string | null) => {
      const logs: string[] = [];
      const app = await buildApp({ config: testConfig({ webDist }), db, logStream: { write: (m) => void logs.push(m) } });
      await app.close();
      return logs.join('');
    };
    expect(await logsOf('does-not-exist')).toContain('web build not found');
    expect(await logsOf(null)).not.toContain('web build not found');
  });
});

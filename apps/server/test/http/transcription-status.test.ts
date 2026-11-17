import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { createStatusCache } from '../../src/fornax/status.js';
import { seedProject, TEST_TOKEN, TEST_WORKER_TOKEN, testConfig, useTestDb } from '../helpers.js';
import { type FakeFornax, startFakeFornax } from '../fake-fornax.js';

const db = useTestDb();
const auth = { authorization: `Bearer ${TEST_TOKEN}` };
let fornax: FakeFornax;
beforeAll(async () => {
  fornax = await startFakeFornax();
});
afterAll(() => fornax.close());

const withApp = async (fn: (get: () => Promise<{ statusCode: number; json: () => Record<string, unknown> }>) => Promise<void>, fornaxCfg = true) => {
  const config = testConfig({ fornax: fornaxCfg ? { url: fornax.url, token: fornax.token, priority: 'high' } : undefined });
  const app = await buildApp({ config, db });
  try {
    await fn(() => app.inject({ method: 'GET', url: '/api/transcription/status', headers: auth }));
  } finally {
    await app.close();
  }
};

describe('GET /api/transcription/status', () => {
  it('without Fornax: disabled, nothing to ask', async () => {
    const before = fornax.requests.length;
    await withApp(async (get) => {
      const res = await get();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: false, online: null, offered: null, url: null, queued: 0, running: 0, failed: 0 });
    }, false);
    expect(fornax.requests.length).toBe(before);
  });

  it('with Fornax: its state, its URL and the counts of open reports', async () => {
    fornax.worker.online = true;
    fornax.worker.offered = true;
    await withApp(async (get) => {
      expect((await get()).json()).toEqual({ enabled: true, online: true, offered: true, url: fornax.url, queued: 0, running: 0, failed: 0 });
    });
    fornax.worker.online = false;
    fornax.worker.offered = false;
    await withApp(async (get) => {
      expect((await get()).json()).toMatchObject({ enabled: true, online: false, offered: false });
    });
    fornax.worker.online = true;
    fornax.worker.offered = true;
  });

  it('caches the answer for 30 s', async () => {
    await withApp(async (get) => {
      const before = fornax.requests.filter((r) => r.path === '/api/types').length;
      await get();
      await get();
      await get();
      expect(fornax.requests.filter((r) => r.path === '/api/types').length - before).toBe(1);
    });
  });

  it('online and offered are null when Fornax cannot be reached; the counts stay', async () => {
    await seedProject(db, 'demo');
    fornax.fail('/api/types', 'network');
    try {
      await withApp(async (get) => {
        const res = await get();
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ enabled: true, online: null, offered: null, url: fornax.url, queued: 0 });
      });
    } finally {
      fornax.fail('/api/types', null);
    }
  });

  it('needs the user token', async () => {
    const app = await buildApp({ config: testConfig(), db });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/transcription/status' })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('the worker API is gone', () => {
  it('answers 404 under /api/worker, whatever the token', async () => {
    const app = await buildApp({ config: testConfig(), db });
    try {
      for (const [method, url] of [['GET', '/api/worker/queue'], ['POST', '/api/worker/claim'], ['GET', '/api/worker/ping']] as const) {
        for (const token of [TEST_TOKEN, TEST_WORKER_TOKEN]) {
          const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
          expect(res.statusCode, `${method} ${url}`).toBe(404);
        }
      }
    } finally {
      await app.close();
    }
  });
});

describe('createStatusCache', () => {
  it('gives up on a slow Fornax after the timeout, and remembers that for the cache time', async () => {
    let calls = 0;
    let clock = 0;
    const cache = createStatusCache({ status: () => (calls++, new Promise(() => {})) }, { timeoutMs: 20, ttlMs: 1000, now: () => clock });
    const t = Date.now();
    expect(await cache.get()).toEqual({ online: null, offered: null });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(await cache.get()).toEqual({ online: null, offered: null });
    expect(calls).toBe(1);
    clock = 1001;
    await cache.get();
    expect(calls).toBe(2);
  });

  it('shares one call between simultaneous requests', async () => {
    let calls = 0;
    const cache = createStatusCache({ status: async () => (calls++, { online: true, offered: true }) });
    expect(await Promise.all([cache.get(), cache.get(), cache.get()])).toEqual(Array(3).fill({ online: true, offered: true }));
    expect(calls).toBe(1);
  });
});

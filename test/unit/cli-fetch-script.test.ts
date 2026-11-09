import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type CliFetch = {
  fetchScript(url: string, name: string, dest: string, opts?: { preferLocal?: boolean }): Promise<void>;
};

// A non-literal specifier keeps TypeScript from looking for type declarations of the plain .mjs file.
const cli = (await import(new URL('../../cli/tabula.mjs', import.meta.url).href)) as CliFetch;

describe('fetchScript on a stale connection', () => {
  let server: Server | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function serve(handler: (n: number, res: import('node:http').ServerResponse) => void) {
    let requests = 0;
    server = createServer((req, res) => {
      if (req.url !== '/cli/diarize.py') { res.statusCode = 500; res.end(); return; }
      handler(++requests, res);
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    dir = mkdtempSync(join(tmpdir(), 'tabula-fetch-'));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dest: join(dir, 'diarize.py'), count: () => requests };
  }

  it('retries once when the first request dies on a closed socket', async () => {
    const s = await serve((n, res) => {
      if (n === 1) res.destroy();
      else res.end('print("synthetic")\n');
    });
    await cli.fetchScript(s.url, 'diarize.py', s.dest, { preferLocal: false });
    expect(s.count()).toBe(2);
    expect(readFileSync(s.dest, 'utf8')).toBe('print("synthetic")\n');
  });

  it('does not retry an HTTP status', async () => {
    const s = await serve((_n, res) => { res.statusCode = 404; res.end('no'); });
    await expect(cli.fetchScript(s.url, 'diarize.py', s.dest, { preferLocal: false })).rejects.toThrow(/HTTP 404/);
    expect(s.count()).toBe(1);
  });
});

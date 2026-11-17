import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const TOKEN = 'x'.repeat(32);

describe('loadConfig', () => {
  it('parses required and default values', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', TABULA_TOKEN: TOKEN });
    expect(c).toEqual({
      databaseUrl: 'postgres://u:p@localhost:5432/db',
      token: TOKEN,
      connectorSecret: undefined,
      fornax: undefined,
      port: 3000,
      host: '0.0.0.0',
      webDist: 'web/dist',
      media: { dir: 'data/media', maxBytes: 1024 * 1024 * 1024, purgeAfterHours: 24, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    });
  });

  it('reads the media settings', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://x', TABULA_TOKEN: TOKEN, TABULA_MEDIA_DIR: '/data/media', TABULA_MEDIA_MAX_MB: '200', TABULA_MEDIA_PURGE_HOURS: '0',
    });
    expect(c.media).toMatchObject({ dir: '/data/media', maxBytes: 200 * 1024 * 1024, purgeAfterHours: 0 });
  });

  it('rejects a short token', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', TABULA_TOKEN: 'short' })).toThrow(/TABULA_TOKEN/);
  });

  it('treats an empty connector secret as unset', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x', TABULA_TOKEN: TOKEN, TABULA_CONNECTOR_SECRET: '' });
    expect(c.connectorSecret).toBeUndefined();
  });

  it('rejects a short connector secret', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://x', TABULA_TOKEN: TOKEN, TABULA_CONNECTOR_SECRET: 'abc' }),
    ).toThrow(/TABULA_CONNECTOR_SECRET/);
  });

  describe('Fornax', () => {
    const base = { DATABASE_URL: 'postgres://x', TABULA_TOKEN: TOKEN };
    const F = { TABULA_FORNAX_URL: 'https://fornax.example.com', TABULA_FORNAX_TOKEN: 'f'.repeat(24) };

    it('is off when neither variable is set (empty counts as unset)', () => {
      expect(loadConfig(base).fornax).toBeUndefined();
      expect(loadConfig({ ...base, TABULA_FORNAX_URL: '', TABULA_FORNAX_TOKEN: '' }).fornax).toBeUndefined();
    });

    it('reads both with priority high by default', () => {
      expect(loadConfig({ ...base, ...F }).fornax).toEqual({ url: 'https://fornax.example.com', token: F.TABULA_FORNAX_TOKEN, priority: 'high' });
    });

    it('honours TABULA_FORNAX_PRIORITY and refuses another value', () => {
      expect(loadConfig({ ...base, ...F, TABULA_FORNAX_PRIORITY: 'low' }).fornax?.priority).toBe('low');
      expect(loadConfig({ ...base, ...F, TABULA_FORNAX_PRIORITY: 'normal' }).fornax?.priority).toBe('normal');
      expect(() => loadConfig({ ...base, ...F, TABULA_FORNAX_PRIORITY: 'urgent' })).toThrow(/TABULA_FORNAX_PRIORITY/);
    });

    it('names the missing variable when only one is set', () => {
      expect(() => loadConfig({ ...base, TABULA_FORNAX_URL: F.TABULA_FORNAX_URL })).toThrow(/TABULA_FORNAX_TOKEN/);
      expect(() => loadConfig({ ...base, TABULA_FORNAX_TOKEN: F.TABULA_FORNAX_TOKEN })).toThrow(/TABULA_FORNAX_URL/);
    });

    it('accepts an http(s) URL without a path and strips the trailing slash', () => {
      expect(loadConfig({ ...base, ...F, TABULA_FORNAX_URL: 'https://fornax.example.com/' }).fornax?.url).toBe('https://fornax.example.com');
      expect(loadConfig({ ...base, ...F, TABULA_FORNAX_URL: 'http://127.0.0.1:8080' }).fornax?.url).toBe('http://127.0.0.1:8080');
      for (const bad of ['ftp://fornax.example.com', 'https://fornax.example.com/api', 'not a url']) {
        expect(() => loadConfig({ ...base, ...F, TABULA_FORNAX_URL: bad })).toThrow(/TABULA_FORNAX_URL/);
      }
    });

    it('does not throw when the retired TABULA_WORKER_TOKEN is set', () => {
      expect(() => loadConfig({ ...base, TABULA_WORKER_TOKEN: 'w'.repeat(32) })).not.toThrow();
    });
  });
});

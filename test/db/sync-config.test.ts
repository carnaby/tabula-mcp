import { beforeEach, describe, expect, it } from 'vitest';
import { getFile, listFileRevisions, putFile } from '../../src/domain/files.js';
import {
  deleteSyncedFile, getSyncConfig, setSyncConfig, SYNC_CONFIG_LIMITS, writeSyncedFile,
} from '../../src/domain/sync-config.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const config = { sync: ['docs/**', '.superpowers/sdd/*/progress.md'], state: ['docs/handoff/*.md'] };
const write = (path: string, content: string, baseSha256?: string | null, project = 'demo') =>
  writeSyncedFile(db, project, { path, content, baseSha256: baseSha256 ?? null }, 'claude-ai');

beforeEach(() => seedProject(db, 'demo'));

describe('sync config', () => {
  it('is unknown until the CLI stores it, and each push replaces it', async () => {
    expect(await getSyncConfig(db, 'demo')).toBeNull();
    expect(await setSyncConfig(db, 'demo', config)).toMatchObject(config);
    expect(await getSyncConfig(db, 'demo')).toMatchObject({ ...config, updatedAt: expect.any(Date) });
    await setSyncConfig(db, 'demo', { sync: ['notes/**'], state: [] });
    expect(await getSyncConfig(db, 'demo')).toMatchObject({ sync: ['notes/**'], state: [] });
  });

  it('validates the patterns', async () => {
    const bad = [
      { sync: [], state: [] },
      { sync: [''], state: [] },
      { sync: ['docs/**'], state: [''] },
      { sync: ['x'.repeat(SYNC_CONFIG_LIMITS.patternChars + 1)], state: [] },
      { sync: Array.from({ length: SYNC_CONFIG_LIMITS.patterns + 1 }, (_, i) => `d${i}/**`), state: [] },
      { sync: ['docs/\n**'], state: [] },
    ];
    for (const c of bad) await expect(setSyncConfig(db, 'demo', c), JSON.stringify(c).slice(0, 60)).rejects.toMatchObject({ code: 'bad_request' });
    expect(await getSyncConfig(db, 'demo')).toBeNull();
  });

  it('refuses the global project and unknown projects', async () => {
    await expect(setSyncConfig(db, 'global', config)).rejects.toMatchObject({ code: 'bad_request', message: expect.stringMatching(/"global"/) });
    await expect(setSyncConfig(db, 'nope', config)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('writeSyncedFile', () => {
  beforeEach(() => setSyncConfig(db, 'demo', config));

  it('creates a new file without a base, as the agent, and marks state files', async () => {
    const r = await write('docs/superpowers/specs/x.md', '# Spec\n');
    expect(r).toEqual({ path: 'docs/superpowers/specs/x.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), version: 1, changed: true, state: false });
    expect(await getFile(db, 'demo', 'docs/superpowers/specs/x.md')).toMatchObject({ content: '# Spec\n', updatedBy: 'claude-ai', isState: false });
    expect(await write('docs/handoff/state.md', 'Next: ship')).toMatchObject({ version: 1, state: true });
    expect((await getFile(db, 'demo', 'docs/handoff/state.md')).isState).toBe(true);
    expect(await write('.superpowers/sdd/plan-1/progress.md', '- [x] one')).toMatchObject({ version: 1 });
  });

  it('requires the base of an existing file and refuses a stale one with the current hash', async () => {
    const v1 = await write('docs/a.md', 'one');
    await expect(write('docs/a.md', 'two')).rejects.toMatchObject({
      code: 'conflict', message: expect.stringMatching(/already exists.*read_file.*base_sha256/s),
    });
    const v2 = await write('docs/a.md', 'two', v1.sha256);
    expect(v2).toMatchObject({ version: 2, changed: true });
    const stale = write('docs/a.md', 'three', v1.sha256);
    await expect(stale).rejects.toMatchObject({ code: 'conflict' });
    await expect(write('docs/a.md', 'three', v1.sha256)).rejects.toThrow(v2.sha256);
    expect((await getFile(db, 'demo', 'docs/a.md')).content).toBe('two');
    expect(await write('docs/a.md', 'two', v2.sha256)).toMatchObject({ version: 2, changed: false });
    expect((await listFileRevisions(db, 'demo', 'docs/a.md')).map((r) => r.updatedBy)).toEqual(['claude-ai']);
  });

  it('accepts a previously deleted file without a base', async () => {
    const v1 = await write('docs/a.md', 'one');
    await deleteSyncedFile(db, 'demo', { path: 'docs/a.md', baseSha256: v1.sha256 });
    expect(await write('docs/a.md', 'again')).toMatchObject({ version: 2, changed: true });
    expect((await getFile(db, 'demo', 'docs/a.md')).deletedAt).toBeNull();
  });

  it('refuses paths outside the sync patterns, naming them, and .env files even inside them', async () => {
    await expect(write('src/a.ts', 'x')).rejects.toMatchObject({
      code: 'bad_request', message: expect.stringContaining('docs/**, .superpowers/sdd/*/progress.md'),
    });
    await expect(write('.superpowers/sdd/a/b/progress.md', 'x')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(write('docs/.env', 'SECRET=1')).rejects.toMatchObject({ code: 'bad_request', message: expect.stringMatching(/\.env/) });
    await expect(write('docs/../src/a.ts', 'x')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(write('docs/big.md', 'x'.repeat(1_048_577))).rejects.toMatchObject({ code: 'too_large' });
  });

  it('refuses a path that differs only in letter case from a live file or folder (one file on Windows and macOS)', async () => {
    await write('docs/Plan.md', 'p');
    await expect(write('docs/plan.md', 'x')).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('"docs/Plan.md"') });
    await write('docs/Specs/a.md', 'a');
    await expect(write('docs/specs/b.md', 'b')).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('"docs/Specs"') });
    await expect(write('DOCS/Specs/a.md', 'b')).rejects.toMatchObject({ code: 'bad_request' });
    expect(await write('docs/Specs/b.md', 'b')).toMatchObject({ version: 1 });
    expect(await write('docs/plan-two.md', 'b')).toMatchObject({ version: 1 });
    // A deleted twin is no obstacle.
    const plan = await getFile(db, 'demo', 'docs/Plan.md');
    await deleteSyncedFile(db, 'demo', { path: 'docs/Plan.md', baseSha256: plan.sha256 });
    expect(await write('docs/plan.md', 'x')).toMatchObject({ version: 1 });
  });

  it('refuses a project without stored patterns, the global project and unknown projects', async () => {
    await seedProject(db, 'fresh');
    await expect(write('docs/a.md', 'x', null, 'fresh')).rejects.toMatchObject({
      code: 'bad_request', message: expect.stringMatching(/run `tabula push` once on a computer with the repository/),
    });
    await expect(write('docs/a.md', 'x', null, 'global')).rejects.toMatchObject({ code: 'bad_request', message: expect.stringMatching(/"global"/) });
    await expect(write('docs/a.md', 'x', null, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('deleteSyncedFile', () => {
  beforeEach(() => setSyncConfig(db, 'demo', config));

  it('needs the hash of the current version and soft-deletes', async () => {
    const v1 = await write('docs/a.md', 'one');
    const v2 = await write('docs/a.md', 'two', v1.sha256);
    await expect(deleteSyncedFile(db, 'demo', { path: 'docs/a.md', baseSha256: v1.sha256 })).rejects.toThrow(v2.sha256);
    expect((await getFile(db, 'demo', 'docs/a.md')).deletedAt).toBeNull();
    expect(await deleteSyncedFile(db, 'demo', { path: 'docs/a.md', baseSha256: v2.sha256 })).toEqual({ path: 'docs/a.md', deleted: true });
    expect((await getFile(db, 'demo', 'docs/a.md')).deletedAt).not.toBeNull();
    await expect(deleteSyncedFile(db, 'demo', { path: 'docs/a.md', baseSha256: v2.sha256 })).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteSyncedFile(db, 'demo', { path: 'docs/none.md', baseSha256: v2.sha256 })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('applies the same project and path rules as writing', async () => {
    await putFile(db, 'demo', { path: 'src/a.md', content: 'x', baseSha256: null }, 'cli');
    const { sha256 } = await getFile(db, 'demo', 'src/a.md');
    await expect(deleteSyncedFile(db, 'demo', { path: 'src/a.md', baseSha256: sha256 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(deleteSyncedFile(db, 'global', { path: 'docs/a.md', baseSha256: sha256 })).rejects.toMatchObject({ code: 'bad_request' });
  });
});

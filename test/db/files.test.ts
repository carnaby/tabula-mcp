import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteFile, getFile, getFileRevision, KEEP_FILE_REVISIONS, listFileRevisions, listFiles, putFile, restoreFile,
  setStatePaths,
} from '../../src/domain/files.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const put = (
  path: string, content: string, baseSha256: string | null, o: { force?: boolean; project?: string; by?: string } = {},
) => putFile(db, o.project ?? 'demo', { path, content, baseSha256, force: o.force }, o.by ?? 'cli');
const sha = async (path: string) => (await getFile(db, 'demo', path)).sha256;

describe('project files', () => {
  beforeEach(() => seedProject(db, 'demo'));

  it('creates version 1 and bumps the version only when the content changes', async () => {
    const v1 = await put('docs/a.md', 'one', null);
    expect(v1).toMatchObject({ ok: true, version: 1, changed: true });
    // Identical content is a no-op, whatever the base.
    expect(await put('docs/a.md', 'one', null)).toEqual({ ok: true, sha256: await sha('docs/a.md'), version: 1, changed: false });
    expect(await put('docs/a.md', 'two', await sha('docs/a.md'), { by: 'claude-code' })).toMatchObject({ ok: true, version: 2 });
    expect(await getFile(db, 'demo', 'docs/a.md')).toMatchObject({ content: 'two', version: 2, updatedBy: 'claude-code', size: 3 });
    expect((await listFileRevisions(db, 'demo', 'docs/a.md')).map((r) => [r.version, r.updatedBy])).toEqual([[1, 'cli']]);
    expect((await getFileRevision(db, 'demo', 'docs/a.md', 1)).content).toBe('one');
  });

  it('refuses a stale or missing base with the current hash, and force overwrites', async () => {
    await put('docs/a.md', 'one', null);
    const base1 = await sha('docs/a.md');
    await put('docs/a.md', 'two', base1);
    const current = await sha('docs/a.md');
    expect(await put('docs/a.md', 'three', base1)).toEqual({ ok: false, sha256: current });
    expect(await put('docs/a.md', 'three', null)).toEqual({ ok: false, sha256: current });
    expect(await put('docs/a.md', 'three', base1, { force: true })).toMatchObject({ ok: true, version: 3 });
  });

  it('never fails with a database error when two writers create the same path at once', async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `docs/race-${i}.md`);
    const results = await Promise.all(
      paths.flatMap((p) => [put(p, 'from A', null), put(p, 'from B', null)].map((r, i) => r.then((x) => ({ p, i, x })))),
    );
    for (const p of paths) {
      const pair = results.filter((r) => r.p === p).map((r) => r.x);
      expect(pair).toHaveLength(2);
      expect(pair.filter((r) => r.ok)).toHaveLength(1);
    }
    expect((await listFiles(db, 'demo')).map((f) => f.path)).toEqual([...paths].sort());
  });

  it(`keeps only the last ${KEEP_FILE_REVISIONS} previous versions`, async () => {
    let base: string | null = null;
    for (let i = 1; i <= KEEP_FILE_REVISIONS + 5; i++) {
      const r = await put('docs/a.md', `v${i}`, base);
      if (!r.ok) throw new Error('unexpected conflict');
      base = r.sha256;
    }
    const revs = await listFileRevisions(db, 'demo', 'docs/a.md');
    expect(revs).toHaveLength(KEEP_FILE_REVISIONS);
    expect([revs[0]!.version, revs.at(-1)!.version]).toEqual([KEEP_FILE_REVISIONS + 4, 5]);
    await expect(getFileRevision(db, 'demo', 'docs/a.md', 4)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('revives a soft-deleted file when identical content is put with base null', async () => {
    await put('docs/a.md', 'same', null);
    await deleteFile(db, 'demo', 'docs/a.md');
    expect(await put('docs/a.md', 'same', null)).toMatchObject({ ok: true, version: 1, changed: true });
    expect((await listFiles(db, 'demo')).map((f) => f.path)).toEqual(['docs/a.md']);
  });

  it('soft-deletes and restores; a write to a deleted path revives it as a new version', async () => {
    await put('docs/a.md', 'one', null);
    expect(await deleteFile(db, 'demo', 'docs/a.md')).toEqual({ changed: true });
    expect(await deleteFile(db, 'demo', 'docs/a.md')).toEqual({ changed: false });
    expect(await listFiles(db, 'demo')).toEqual([]);
    expect((await listFiles(db, 'demo', { includeDeleted: true }))[0]).toMatchObject({
      path: 'docs/a.md', deletedAt: expect.any(Date),
    });
    expect(await restoreFile(db, 'demo', 'docs/a.md')).toEqual({ changed: true });
    expect((await getFile(db, 'demo', 'docs/a.md')).deletedAt).toBeNull();
    await deleteFile(db, 'demo', 'docs/a.md');
    expect(await put('docs/a.md', 'edited after the delete', 'an-old-base')).toMatchObject({ ok: true, version: 2 });
    expect((await getFile(db, 'demo', 'docs/a.md')).deletedAt).toBeNull();
  });

  it('keeps paths per project and validates input', async () => {
    await seedProject(db, 'other');
    await put('docs/a.md', 'demo', null);
    await put('docs/a.md', 'other', null, { project: 'other' });
    expect((await getFile(db, 'other', 'docs/a.md')).content).toBe('other');
    await expect(put('../a.md', 'x', null)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(put('docs/b.md', `a${String.fromCharCode(0)}`, null)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(put('docs/a.md', 'x', null, { project: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(getFile(db, 'demo', 'docs/missing.md')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('marks state files without touching their dates', async () => {
    await put('docs/handoff/state.md', 's', null);
    await put('docs/plan.md', 'p', null);
    const before = (await getFile(db, 'demo', 'docs/handoff/state.md')).updatedAt;
    expect(await setStatePaths(db, 'demo', ['docs/handoff/state.md'])).toEqual({ updated: 1 });
    expect(await setStatePaths(db, 'demo', ['docs/handoff/state.md'])).toEqual({ updated: 0 });
    const files = await listFiles(db, 'demo');
    expect(files.map((f) => [f.path, f.isState])).toEqual([['docs/handoff/state.md', true], ['docs/plan.md', false]]);
    expect(files[0]!.updatedAt.getTime()).toBe(before.getTime());
    expect(await setStatePaths(db, 'demo', [])).toEqual({ updated: 1 });
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentDeleteFile, agentDeprecate, agentFindNotes, agentGet, agentListFiles, agentReadFile, agentRemember, agentUpdateThought,
  agentWriteFile, type AgentBlock, type AgentContext, GLOBAL_ONLY, READ_CHUNK,
} from '../../src/agent/operations.js';
import { memories } from '../../src/db/schema.js';
import { AGENT_READ_ONLY } from '../../src/domain/errors.js';
import { deleteFile, getFile, listFiles, putFile, setStatePaths } from '../../src/domain/files.js';
import { createMemory, getMemory, listMemories } from '../../src/domain/memories.js';
import { createNote } from '../../src/domain/notes.js';
import { setSyncConfig } from '../../src/domain/sync-config.js';
import { createThought, HUMAN } from '../../src/domain/thoughts.js';
import { refOf } from '../../src/shared/refs.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const ctx: AgentContext = { db, agentLabel: 'claude-code' };
const input = { project: 'global', kind: 'rule' as const, title: 'Run tests via pnpm', body: 'Setup lives there.' };
const textOf = (b: AgentBlock) => (b.type === 'text' ? b.text : '');
const viewOf = async (id: string) => JSON.parse(textOf((await agentGet(ctx, id))[1]!));
const human = () => createMemory(db, { projectId: 'global', kind: 'rule', title: 'Human rule', body: 'By hand.', source: 'human' });

describe('agent operations', () => {
  beforeEach(() => seedProject(db, 'demo'));

  it('remember writes a global rule with source=agent and the agent label', async () => {
    const { id } = await agentRemember(ctx, input);
    expect(await getMemory(db, id)).toMatchObject({ projectId: 'global', source: 'agent', agentLabel: 'claude-code', status: 'active' });
  });

  it('remember and deprecate refuse everything outside global and say why', async () => {
    await expect(agentRemember(ctx, { ...input, project: 'demo' })).rejects.toMatchObject({ code: 'bad_request', message: GLOBAL_ONLY });
    const legacy = await createMemory(db, { projectId: 'demo', kind: 'fact', title: 'Old project memory', body: 'b', source: 'agent' });
    await expect(agentDeprecate(ctx, { id: legacy.id, reason: 'x' })).rejects.toMatchObject({ code: 'bad_request', message: GLOBAL_ONLY });
    await expect(agentRemember(ctx, { ...input, supersedes_id: legacy.id })).rejects.toMatchObject({ message: GLOBAL_ONLY });
    expect(await listMemories(db, { status: 'all' })).toHaveLength(1);
    // The agent must not "fix" the error by writing the project knowledge as a global rule instead.
    expect(GLOBAL_ONLY).toMatch(/do not retry with project "global" unless the user asked for a rule that applies to every project/i);
  });

  it('remember accepts a short supersedes id', async () => {
    const { id: oldId } = await agentRemember(ctx, input);
    const { id: newId } = await agentRemember(ctx, { ...input, supersedes_id: `#${oldId.slice(0, 8)}` });
    expect(await getMemory(db, oldId)).toMatchObject({ status: 'deprecated', deprecatedReason: `superseded by ${newId}` });
  });

  it('deprecate and remember(supersedes_id) reject a thought id', async () => {
    const t = await createThought(db, { title: 'A thought' }, HUMAN);
    await expect(agentDeprecate(ctx, { id: t.id, reason: 'x' })).rejects.toMatchObject({
      code: 'bad_request', message: expect.stringMatching(/is a thought, not a memory/),
    });
    await expect(agentRemember(ctx, { ...input, supersedes_id: t.id })).rejects.toMatchObject({ code: 'bad_request' });
    expect(await listMemories(db, { status: 'all' })).toHaveLength(0);
  });

  it('update_thought requires expected_version for body or title, not for append', async () => {
    const t = await createThought(db, { title: 'T', body: 'b' }, HUMAN);
    await expect(agentUpdateThought(ctx, { id: t.id, body: 'x' })).rejects.toMatchObject({
      code: 'bad_request', message: expect.stringMatching(/expected_version is required.*get or find_thoughts/),
    });
    await expect(agentUpdateThought(ctx, { id: t.id, title: 'x' })).rejects.toMatchObject({ code: 'bad_request' });
    expect(await agentUpdateThought(ctx, { id: t.id, append: 'more' })).toEqual({ id: t.id, ref: refOf(t.id), version: 2 });
    expect(await agentUpdateThought(ctx, { id: t.id, body: 'new', expected_version: 2 })).toEqual({ id: t.id, ref: refOf(t.id), version: 3 });
    await expect(agentUpdateThought(ctx, { id: t.id, body: 'stale', expected_version: 2 })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('update_thought rejects a memory or note id', async () => {
    const m = await agentRemember(ctx, input);
    await expect(agentUpdateThought(ctx, { id: m.id, append: 'x' })).rejects.toMatchObject({ code: 'bad_request' });
    const n = await createNote(db, { title: 'Note' });
    await expect(agentUpdateThought(ctx, { id: n.id, append: 'x' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('remember cannot supersede human records or notes', async () => {
    const h = await human();
    await expect(agentRemember(ctx, { ...input, supersedes_id: h.id })).rejects.toMatchObject({
      code: 'forbidden', message: AGENT_READ_ONLY,
    });
    const n = await createNote(db, { title: 'Note' });
    await expect(agentRemember(ctx, { ...input, supersedes_id: n.id })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await listMemories(db, { status: 'all' })).toHaveLength(1);
  });

  it('deprecate enforces read-only human records and notes, and is idempotent', async () => {
    const h = await human();
    await expect(agentDeprecate(ctx, { id: h.id, reason: 'x' })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    const n = await createNote(db, { title: 'Note' });
    await expect(agentDeprecate(ctx, { id: n.id, reason: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    const { id } = await agentRemember(ctx, input);
    expect(await agentDeprecate(ctx, { id, reason: 'changed' })).toEqual({ ok: true });
    expect(await agentDeprecate(ctx, { id, reason: 'again' })).toEqual({ ok: true });
  });

  it('get starts with a line saying what the record is, then its full view with the ref', async () => {
    const { id } = await agentRemember(ctx, { ...input, tags: ['ci'] });
    const blocks = await agentGet(ctx, `#${id.slice(0, 6)}`);
    expect(textOf(blocks[0]!)).toBe(`${refOf(id)} · global rule · Run tests via pnpm`);
    expect(await viewOf(refOf(id))).toMatchObject({
      type: 'memory', ref: refOf(id), id, project: 'global', body: 'Setup lives there.', tags: ['ci'], agent_label: 'claude-code',
    });
    const n = await createNote(db, { projectId: 'demo', title: 'Arch', body: 'Long body' });
    expect(textOf((await agentGet(ctx, n.id))[0]!)).toBe(`${refOf(n.id)} · note · project demo · Arch`);
    expect(await viewOf(n.id)).toMatchObject({ type: 'note', ref: refOf(n.id), project: 'demo', body: 'Long body', pinned: false });
  });

  it('get shows a file like read_file: a long one in part with the offset, a deleted one with its last content', async () => {
    await putFile(db, 'demo', { path: 'docs/long.md', content: 'a'.repeat(READ_CHUNK + 10), baseSha256: null }, 'cli');
    await putFile(db, 'demo', { path: 'docs/gone.md', content: 'last words', baseSha256: null }, 'cli');
    await deleteFile(db, 'demo', 'docs/gone.md');
    const files = await listFiles(db, 'demo', { includeDeleted: true });
    const idOf = (path: string) => files.find((f) => f.path === path)!.id;

    const long = await agentGet(ctx, refOf(idOf('docs/long.md')));
    expect(long).toHaveLength(4);
    expect(textOf(long[0]!)).toBe(`${refOf(idOf('docs/long.md'))} · project file · project demo · docs/long.md`);
    expect(textOf(long[1]!)).toMatch(/^\[file docs\/long\.md · tabula:[0-9a-f]{8} · version 1 · sha256 [0-9a-f]{64} · 100010 characters\]$/);
    expect(textOf(long[2]!)).toBe('a'.repeat(READ_CHUNK));
    expect(textOf(long[3]!)).toBe(
      `[… part ends at character ${READ_CHUNK} of ${READ_CHUNK + 10} — call read_file with project "demo", path "docs/long.md" and offset: ${READ_CHUNK}]`,
    );

    const gone = await agentGet(ctx, refOf(idOf('docs/gone.md')));
    expect(textOf(gone[0]!)).toMatch(/^tabula:[0-9a-f]{8} · project file · project demo · deleted \d{4}-\d{2}-\d{2} · docs\/gone\.md$/);
    expect(textOf(gone[1]!)).toMatch(/^\[deleted on \d{4}-\d{2}-\d{2}: below is its last content; the user can restore it in the Tabula app/);
    expect(textOf(gone.at(-1)!)).toBe('last words');
  });

  it('get reports ambiguous prefixes and misses', async () => {
    const row = { projectId: 'demo', kind: 'fact' as const, body: 'b', source: 'agent' as const };
    await db.insert(memories).values([
      { ...row, id: 'abcd1000-0000-4000-8000-000000000000', title: 'First' },
      { ...row, id: 'abcd2000-0000-4000-8000-000000000000', title: 'Second' },
    ]);
    await expect(agentGet(ctx, '#abcd')).rejects.toThrow(/ambiguous.*First.*Second|ambiguous.*Second.*First/s);
    await expect(agentGet(ctx, '#ffff')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists and reads synced files with their hash and version, long ones in parts, never deleted ones', async () => {
    const st = await putFile(db, 'demo', { path: 'docs/handoff/state.md', content: 'Next: ship', baseSha256: null }, 'cli');
    await putFile(db, 'demo', { path: 'docs/long.md', content: 'a'.repeat(READ_CHUNK + 10), baseSha256: null }, 'cli');
    await setStatePaths(db, 'demo', ['docs/handoff/state.md']);
    const sha = st.sha256;
    expect(await agentListFiles(ctx, 'demo')).toMatchObject([
      { path: 'docs/handoff/state.md', size: 10, version: 1, sha256: sha, state: true, updated_by: 'cli' },
      { path: 'docs/long.md', state: false },
    ]);
    const { id: stateId } = await getFile(db, 'demo', 'docs/handoff/state.md');
    expect(await agentReadFile(ctx, { project: 'demo', path: 'docs/handoff/state.md' })).toEqual({
      header: `[file docs/handoff/state.md · ${refOf(stateId)} · version 1 · sha256 ${sha} · 10 characters]`,
      text: 'Next: ship',
    });
    const first = await agentReadFile(ctx, { project: 'demo', path: 'docs/long.md' });
    expect(first.text).toBe('a'.repeat(READ_CHUNK));
    expect(first.header).toMatch(/^\[file docs\/long\.md · tabula:[0-9a-f]{8} · version 1 · sha256 [0-9a-f]{64} · 100010 characters\]$/);
    expect(first.footer).toBe(
      `[… part ends at character ${READ_CHUNK} of ${READ_CHUNK + 10} — call read_file again with offset: ${READ_CHUNK}]`,
    );
    const rest = await agentReadFile(ctx, { project: 'demo', path: 'docs/long.md', offset: READ_CHUNK });
    expect(rest).toMatchObject({ text: 'a'.repeat(10), header: expect.stringContaining(`from character ${READ_CHUNK}`) });
    expect(rest.footer).toBeUndefined();
    expect(await agentReadFile(ctx, { project: 'demo', path: 'docs/long.md', offset: READ_CHUNK + 10 })).toEqual({
      header: `[offset ${READ_CHUNK + 10} is past the end of the file (${READ_CHUNK + 10} characters)]`,
    });
    await deleteFile(db, 'demo', 'docs/handoff/state.md');
    await expect(agentReadFile(ctx, { project: 'demo', path: 'docs/handoff/state.md' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('never splits a surrogate pair at a chunk boundary', async () => {
    const content = `${'a'.repeat(READ_CHUNK - 1)}\u{1F600}b`;
    await putFile(db, 'demo', { path: 'docs/emoji.md', content, baseSha256: null }, 'cli');
    const first = await agentReadFile(ctx, { project: 'demo', path: 'docs/emoji.md' });
    const m = /call read_file again with offset: (\d+)\]$/.exec(first.footer ?? '')!;
    const next = Number(m[1]);
    expect(next).toBe(READ_CHUNK - 1);
    const second = await agentReadFile(ctx, { project: 'demo', path: 'docs/emoji.md', offset: next });
    expect(first.text).toBe('a'.repeat(READ_CHUNK - 1));
    expect(second.text).toBe('\u{1F600}b');
    expect(first.text! + second.text!).toBe(content);
  });

  it('writes and deletes synced files as the agent, within the stored sync patterns', async () => {
    await expect(agentWriteFile(ctx, { project: 'demo', path: 'docs/a.md', content: 'x' })).rejects.toMatchObject({
      code: 'bad_request', message: expect.stringMatching(/tabula push/),
    });
    await setSyncConfig(db, 'demo', { sync: ['docs/**'], state: ['docs/handoff/*.md'] });
    const w = await agentWriteFile(ctx, { project: 'demo', path: 'docs/handoff/state.md', content: 'Next: cloud' });
    expect(w).toEqual({ path: 'docs/handoff/state.md', ref: expect.stringMatching(/^tabula:[0-9a-f]{8}$/), sha256: expect.stringMatching(/^[0-9a-f]{64}$/), version: 1, changed: true, state: true });
    expect(await agentListFiles(ctx, 'demo')).toMatchObject([{ path: 'docs/handoff/state.md', state: true, updated_by: 'claude-code' }]);
    await expect(agentWriteFile(ctx, { project: 'demo', path: 'docs/handoff/state.md', content: 'v2' })).rejects.toMatchObject({ code: 'conflict' });
    const w2 = await agentWriteFile(ctx, { project: 'demo', path: 'docs/handoff/state.md', content: 'v2', base_sha256: w.sha256 });
    expect(w2).toMatchObject({ version: 2, changed: true });
    await expect(agentDeleteFile(ctx, { project: 'demo', path: 'docs/handoff/state.md', base_sha256: w.sha256 }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await agentDeleteFile(ctx, { project: 'demo', path: 'docs/handoff/state.md', base_sha256: w2.sha256 })).toEqual({
      path: 'docs/handoff/state.md', deleted: true,
    });
    expect(await agentListFiles(ctx, 'demo')).toEqual([]);
  });

  it('finds notebook notes', async () => {
    const n = await createNote(db, { title: 'Suno prompts', body: 'short stingers' });
    expect(await agentFindNotes(ctx, { query: 'stinger' })).toMatchObject([{ id: n.id, title: 'Suno prompts' }]);
  });
});

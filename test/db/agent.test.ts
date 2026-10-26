import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentDeprecate, agentFindNotes, agentGet, agentListFiles, agentReadFile, agentRemember, agentUpdateThought,
  type AgentContext, GLOBAL_ONLY, READ_CHUNK,
} from '../../src/agent/operations.js';
import { memories } from '../../src/db/schema.js';
import { AGENT_READ_ONLY } from '../../src/domain/errors.js';
import { deleteFile, putFile, setStatePaths } from '../../src/domain/files.js';
import { createMemory, getMemory, listMemories } from '../../src/domain/memories.js';
import { createNote } from '../../src/domain/notes.js';
import { createThought, HUMAN } from '../../src/domain/thoughts.js';
import { seedProject, useTestDb } from '../helpers.js';

const db = useTestDb();
const ctx: AgentContext = { db, agentLabel: 'claude-code' };
const input = { project: 'global', kind: 'rule' as const, title: 'Run tests via pnpm', body: 'Setup lives there.' };
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
    expect(await agentUpdateThought(ctx, { id: t.id, append: 'more' })).toEqual({ id: t.id, version: 2 });
    expect(await agentUpdateThought(ctx, { id: t.id, body: 'new', expected_version: 2 })).toEqual({ id: t.id, version: 3 });
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

  it('get returns full memory and note views by prefix', async () => {
    const { id } = await agentRemember(ctx, { ...input, tags: ['ci'] });
    expect(await agentGet(ctx, `#${id.slice(0, 6)}`)).toMatchObject({
      type: 'memory', id, project: 'global', body: 'Setup lives there.', tags: ['ci'], agent_label: 'claude-code',
    });
    const n = await createNote(db, { title: 'Arch', body: 'Long body' });
    expect(await agentGet(ctx, n.id)).toMatchObject({ type: 'note', project: null, body: 'Long body', pinned: false });
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

  it('lists and reads synced files, long ones in parts, never deleted ones', async () => {
    await putFile(db, 'demo', { path: 'docs/handoff/state.md', content: 'Next: ship', baseSha256: null }, 'cli');
    await putFile(db, 'demo', { path: 'docs/long.md', content: 'a'.repeat(READ_CHUNK + 10), baseSha256: null }, 'cli');
    await setStatePaths(db, 'demo', ['docs/handoff/state.md']);
    expect(await agentListFiles(ctx, 'demo')).toMatchObject([
      { path: 'docs/handoff/state.md', size: 10, version: 1, state: true, updated_by: 'cli' },
      { path: 'docs/long.md', state: false },
    ]);
    expect(await agentReadFile(ctx, { project: 'demo', path: 'docs/handoff/state.md' })).toBe('Next: ship');
    const first = await agentReadFile(ctx, { project: 'demo', path: 'docs/long.md' });
    expect(first.endsWith(
      `[… part ends at character ${READ_CHUNK} of ${READ_CHUNK + 10} — call read_file again with offset: ${READ_CHUNK}]`,
    )).toBe(true);
    expect(await agentReadFile(ctx, { project: 'demo', path: 'docs/long.md', offset: READ_CHUNK })).toBe('a'.repeat(10));
    await deleteFile(db, 'demo', 'docs/handoff/state.md');
    await expect(agentReadFile(ctx, { project: 'demo', path: 'docs/handoff/state.md' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('never splits a surrogate pair at a chunk boundary', async () => {
    const content = `${'a'.repeat(READ_CHUNK - 1)}\u{1F600}b`;
    await putFile(db, 'demo', { path: 'docs/emoji.md', content, baseSha256: null }, 'cli');
    const first = await agentReadFile(ctx, { project: 'demo', path: 'docs/emoji.md' });
    const m = /^([\s\S]*)\n\n\[… part ends at character (\d+) of \d+ — call read_file again with offset: (\d+)\]$/.exec(first)!;
    const next = Number(m[3]);
    expect(next).toBe(READ_CHUNK - 1);
    const second = await agentReadFile(ctx, { project: 'demo', path: 'docs/emoji.md', offset: next });
    expect(m[1]).toBe('a'.repeat(READ_CHUNK - 1));
    expect(second).toBe('\u{1F600}b');
    expect(m[1] + second).toBe(content);
  });

  it('finds notebook notes', async () => {
    const n = await createNote(db, { title: 'Suno prompts', body: 'short stingers' });
    expect(await agentFindNotes(ctx, { query: 'stinger' })).toMatchObject([{ id: n.id, title: 'Suno prompts' }]);
  });
});

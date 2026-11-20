import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  authenticateAccessToken, countClientsWithoutConnection, createClient, createConnection, createPending, findClient, findPending, insertCode,
  issueTokenPair, listLiveConnections, renameConnection, revokeConnection, takePending,
} from '../../src/auth/oauth/store.js';
import { oauthCodes, oauthConnections, oauthRefreshTokens } from '../../src/db/schema.js';
import { issueTestAccessToken, useTestDb } from '../helpers.js';

const db = useTestDb();
const CB = 'https://client.example.com/cb';
const app = () => createClient(db, { clientName: 'App', redirectUris: [CB] });
const connect = async (name = 'app', resource: 'mcp' | 'api' = 'mcp') =>
  createConnection(db, { clientId: (await app()).id, name, resource, scope: resource, redirectUri: CB });
const later = (ms: number, from = new Date()) => new Date(from.getTime() + ms);

describe('OAuth store', () => {
  it('finds a client only by a well-formed, existing id', async () => {
    const c = await app();
    expect((await findClient(db, c.id))?.clientName).toBe('App');
    expect(await findClient(db, 'not-a-uuid')).toBeUndefined();
    expect(await findClient(db, '00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });

  it('gives a pending request out once, and never after it expired', async () => {
    const c = await app();
    const input = { clientId: c.id, redirectUri: CB, codeChallenge: 'c'.repeat(43), resource: 'mcp' as const, scope: 'mcp', state: 's' };
    const p = await createPending(db, { ...input, expiresAt: later(60_000) });
    expect((await findPending(db, p.id, new Date()))?.id).toBe(p.id);
    expect((await takePending(db, p.id, new Date()))?.id).toBe(p.id);
    expect(await takePending(db, p.id, new Date())).toBeUndefined();
    const old = await createPending(db, { ...input, expiresAt: later(-1) });
    expect(await findPending(db, old.id, new Date())).toBeUndefined();
    expect(await takePending(db, old.id, new Date())).toBeUndefined();
    expect(await takePending(db, 'nope', new Date())).toBeUndefined();
  });

  it('accepts an access token only for the resource it was issued for', async () => {
    const conn = await connect('claude-code', 'mcp');
    const pair = await issueTokenPair(db, conn, new Date());
    expect(pair.expiresIn).toBe(3600);
    expect(await authenticateAccessToken(db, pair.accessToken, 'mcp', new Date())).toEqual({ ok: true, connectionId: conn.id, name: 'claude-code' });
    expect(await authenticateAccessToken(db, pair.accessToken, 'api', new Date())).toEqual({ ok: false });
    expect(await authenticateAccessToken(db, pair.refreshToken, 'mcp', new Date())).toEqual({ ok: false });
    expect(await authenticateAccessToken(db, 'unknown', 'mcp', new Date())).toEqual({ ok: false });
  });

  it('refuses an expired token and every token of a revoked connection', async () => {
    const conn = await connect();
    const pair = await issueTokenPair(db, conn, new Date());
    expect((await authenticateAccessToken(db, pair.accessToken, 'mcp', later(3601_000))).ok).toBe(false);
    await revokeConnection(db, conn.id, new Date());
    expect((await authenticateAccessToken(db, pair.accessToken, 'mcp', new Date())).ok).toBe(false);
  });

  it('marks the connection used at most once a minute', async () => {
    const t0 = new Date();
    const { value, connectionId } = await issueTestAccessToken(db, { resource: 'mcp' });
    const usedAt = async () => (await db.select().from(oauthConnections).where(eq(oauthConnections.id, connectionId)))[0]!.lastUsedAt;
    await authenticateAccessToken(db, value, 'mcp', t0);
    expect(await usedAt()).toEqual(t0);
    await authenticateAccessToken(db, value, 'mcp', later(30_000, t0));
    expect(await usedAt()).toEqual(t0);
    await authenticateAccessToken(db, value, 'mcp', later(61_000, t0));
    expect(await usedAt()).toEqual(later(61_000, t0));
  });

  it('revoking a connection also ends its refresh tokens and unused codes', async () => {
    const conn = await connect();
    const now = new Date();
    await issueTokenPair(db, conn, now);
    await insertCode(db, { connectionId: conn.id, redirectUri: CB, codeChallenge: 'c'.repeat(43), resource: 'mcp', scope: 'mcp', now });
    await revokeConnection(db, conn.id, now);
    const [refresh] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.connectionId, conn.id));
    const [code] = await db.select().from(oauthCodes).where(eq(oauthCodes.connectionId, conn.id));
    expect(refresh!.expiresAt.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(code!.expiresAt.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(await listLiveConnections(db)).toEqual([]);
  });

  it('stores codes and tokens only as hashes', async () => {
    const conn = await connect();
    const now = new Date();
    const code = await insertCode(db, { connectionId: conn.id, redirectUri: CB, codeChallenge: 'c'.repeat(43), resource: 'mcp', scope: 'mcp', now });
    const pair = await issueTokenPair(db, conn, now);
    const dump = JSON.stringify([await db.select().from(oauthCodes), await db.select().from(oauthRefreshTokens)]);
    for (const secret of [code, pair.accessToken, pair.refreshToken]) expect(dump).not.toContain(secret);
  });

  it('renames a live connection and refuses a taken or invalid name', async () => {
    const a = await connect('one');
    await connect('two');
    expect((await renameConnection(db, a.id, 'uno')).name).toBe('uno');
    await expect(renameConnection(db, a.id, 'two')).rejects.toMatchObject({ code: 'conflict' });
    await expect(renameConnection(db, a.id, 'Bad Name')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(renameConnection(db, 'nope', 'x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('counts the clients nobody approved', async () => {
    await app();
    await connect();
    expect(await countClientsWithoutConnection(db)).toBe(1);
  });
});

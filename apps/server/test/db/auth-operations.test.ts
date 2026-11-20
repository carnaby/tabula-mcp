import { eq } from 'drizzle-orm';
import { describe, expect, inject, it } from 'vitest';
import { runAdmin } from '../../src/admin.js';
import { createClient, createConnection, createPending, insertCode, issueTokenPair, revokeConnection } from '../../src/auth/oauth/store.js';
import { createRegistration, findRegistration } from '../../src/auth/passkeys/registrations.js';
import { insertPasskey, saveChallenge } from '../../src/auth/passkeys/store.js';
import { hashSecret } from '../../src/auth/secrets.js';
import { createSession } from '../../src/auth/sessions.js';
import { announceFirstPasskey } from '../../src/auth/startup.js';
import { authSettings } from '../../src/auth/settings.js';
import { sweepAuth } from '../../src/auth/sweep.js';
import {
  oauthAccessTokens, oauthClients, oauthCodes, oauthConnections, oauthPending, oauthRefreshTokens, passkeyRegistrations, uiSessions,
  webauthnChallenges,
} from '../../src/db/schema.js';
import { TEST_TOKEN, useTestDb } from '../helpers.js';

const db = useTestDb();
const DAY = 24 * 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const auth = authSettings({ publicUrl: 'https://tabula.example.com' })!;
const CB = 'https://client.example.com/cb';
const eqId = (id: string) => eq(oauthClients.id, id);

describe('sweepAuth', () => {
  it('deletes what can no longer be used and keeps the rest', async () => {
    const now = new Date();
    const stale = await createClient(db, { clientName: 'old', redirectUris: [CB] });
    await db.update(oauthClients).set({ createdAt: ago(2 * DAY) }).where(eqId(stale.id));
    const kept = await createClient(db, { clientName: 'approved', redirectUris: [CB] });
    await db.update(oauthClients).set({ createdAt: ago(2 * DAY) }).where(eqId(kept.id));
    const conn = await createConnection(db, { clientId: kept.id, name: 'kept', resource: 'mcp', scope: 'mcp', redirectUri: CB });
    await createPending(db, { clientId: kept.id, redirectUri: CB, codeChallenge: 'c'.repeat(43), resource: 'mcp', scope: 'mcp', state: null, expiresAt: ago(60_000) });
    await insertCode(db, { connectionId: conn.id, redirectUri: CB, codeChallenge: 'c'.repeat(43), resource: 'mcp', scope: 'mcp', now: ago(2 * 3600_000) });
    await issueTokenPair(db, conn, ago(40 * DAY));
    await issueTokenPair(db, conn, now);
    await saveChallenge(db, { challenge: 'old', purpose: 'login', registrationId: null, now: ago(10 * 60_000) });
    await createRegistration(db, 'link', ago(2 * DAY));
    await createSession(db, { userAgent: 'old', now: ago(31 * DAY) });
    await createSession(db, { userAgent: 'new', now });

    expect(await sweepAuth(db, now)).toEqual({ pending: 1, codes: 1, refresh: 1, access: 1, clients: 1, challenges: 1, registrations: 1, sessions: 1 });
    expect((await db.select().from(oauthClients)).map((c) => c.clientName)).toEqual(['approved']);
    expect(await db.select().from(oauthCodes)).toHaveLength(0);
    expect(await db.select().from(oauthRefreshTokens)).toHaveLength(1);
    expect(await db.select().from(oauthAccessTokens)).toHaveLength(1);
    expect(await db.select().from(oauthPending)).toHaveLength(0);
    expect(await db.select().from(webauthnChallenges)).toHaveLength(0);
    expect(await db.select().from(passkeyRegistrations)).toHaveLength(0);
    expect((await db.select().from(uiSessions)).map((s) => s.userAgent)).toEqual(['new']);
  });

  it('keeps used codes for an hour, rotated refresh tokens for a day and revoked connections for good', async () => {
    const now = new Date();
    const old = await createClient(db, { clientName: 'revoked app', redirectUris: [CB] });
    await db.update(oauthClients).set({ createdAt: ago(2 * DAY) }).where(eqId(old.id));
    const revoked = await createConnection(db, { clientId: old.id, name: 'gone', resource: 'mcp', scope: 'mcp', redirectUri: CB });
    await revokeConnection(db, revoked.id, ago(2 * DAY));
    // Registered just now and not approved yet: it has its 24 hours.
    const fresh = await createClient(db, { clientName: 'new app', redirectUris: [CB] });
    const live = await createClient(db, { clientName: 'live app', redirectUris: [CB] });
    const conn = await createConnection(db, { clientId: live.id, name: 'live', resource: 'mcp', scope: 'mcp', redirectUri: CB });
    await createPending(db, { clientId: fresh.id, redirectUri: CB, codeChallenge: 'c'.repeat(43), resource: 'mcp', scope: 'mcp', state: null, expiresAt: new Date(now.getTime() + 60_000) });

    const code = (minutesAgo: number) =>
      insertCode(db, { connectionId: conn.id, redirectUri: CB, codeChallenge: 'c'.repeat(43), resource: 'mcp', scope: 'mcp', now: ago(minutesAgo * 60_000) });
    const useCode = (c: string, at: Date) => db.update(oauthCodes).set({ usedAt: at }).where(eq(oauthCodes.hash, hashSecret(c)));
    const usedRecently = await code(1);
    await useCode(usedRecently, ago(30 * 60_000));
    const usedLongAgo = await code(1);
    await useCode(usedLongAgo, ago(2 * 3600_000));
    await code(40); // expired 30 minutes ago, unused

    const replace = (t: string, at: Date) => db.update(oauthRefreshTokens).set({ replacedAt: at }).where(eq(oauthRefreshTokens.hash, hashSecret(t)));
    const recent = await issueTokenPair(db, conn, now);
    await replace(recent.refreshToken, ago(2 * 3600_000));
    const rotatedLongAgo = await issueTokenPair(db, conn, now);
    await replace(rotatedLongAgo.refreshToken, ago(2 * DAY));
    // Its access token expired an hour ago and its refresh token two hours ago: both within their day.
    const expiring = await issueTokenPair(db, conn, ago(2 * 3600_000));
    await db.update(oauthRefreshTokens).set({ expiresAt: ago(2 * 3600_000) }).where(eq(oauthRefreshTokens.hash, hashSecret(expiring.refreshToken)));

    await saveChallenge(db, { challenge: 'live', purpose: 'login', registrationId: null, now });
    await createRegistration(db, 'link', ago(3600_000));
    await createSession(db, { userAgent: 'live', now: ago(29 * DAY) });

    expect(await sweepAuth(db, now)).toEqual({ pending: 0, codes: 1, refresh: 1, access: 0, clients: 0, challenges: 0, registrations: 0, sessions: 0 });
    expect((await db.select().from(oauthClients)).map((c) => c.clientName).sort()).toEqual(['live app', 'new app', 'revoked app']);
    const connections = await db.select().from(oauthConnections);
    expect(connections.map((c) => [c.name, c.revokedAt !== null]).sort()).toEqual([['gone', true], ['live', false]]);
    expect(await db.select().from(oauthCodes)).toHaveLength(2);
    expect(await db.select().from(oauthRefreshTokens)).toHaveLength(2);
    expect(await db.select().from(oauthAccessTokens)).toHaveLength(3);
    expect(await db.select().from(oauthPending)).toHaveLength(1);
    expect(await db.select().from(webauthnChallenges)).toHaveLength(1);
    expect(await db.select().from(passkeyRegistrations)).toHaveLength(1);
    expect(await db.select().from(uiSessions)).toHaveLength(1);
  });
});

describe('the first passkey', () => {
  const log = () => {
    const lines: string[] = [];
    return { lines, info: (m: string) => void lines.push(`info ${m}`), warn: (m: string) => void lines.push(`warn ${m}`) };
  };

  it('logs a working registration link at start while no passkey exists', async () => {
    const l = log();
    await announceFirstPasskey(db, auth, l);
    expect(l.lines).toHaveLength(1);
    const token = /\/passkey\/register\/([A-Za-z0-9_-]{43}) /.exec(l.lines[0]!)?.[1];
    expect(l.lines[0]).toMatch(/^warn No passkey is registered yet\. Open https:\/\/tabula\.example\.com\/passkey\/register\//);
    expect(await findRegistration(db, token!, new Date())).toBeDefined();
  });

  it('a new start ends the link the previous start logged', async () => {
    const first = log();
    await announceFirstPasskey(db, auth, first);
    const earlier = /\/passkey\/register\/([A-Za-z0-9_-]{43}) /.exec(first.lines[0]!)?.[1];
    const second = log();
    await announceFirstPasskey(db, auth, second);
    const later = /\/passkey\/register\/([A-Za-z0-9_-]{43}) /.exec(second.lines[0]!)?.[1];
    expect(await findRegistration(db, earlier!, new Date())).toBeUndefined();
    expect(await findRegistration(db, later!, new Date())).toBeDefined();
  });

  it('logs nothing once a passkey exists, and says why passkeys are off without TABULA_PUBLIC_URL', async () => {
    await insertPasskey(db, { credentialId: 'c', publicKey: 'p', counter: 0, transports: [], name: 'x', now: new Date() });
    const l = log();
    await announceFirstPasskey(db, auth, l);
    expect(l.lines).toEqual([]);
    await announceFirstPasskey(db, null, l);
    expect(l.lines).toEqual(['info TABULA_PUBLIC_URL is not set: passkeys and OAuth are off; the web UI and MCP accept only TABULA_TOKEN']);
    expect(await db.select().from(passkeyRegistrations)).toHaveLength(0);
  });

  it('creates no link without TABULA_PUBLIC_URL even when no passkey exists', async () => {
    const l = log();
    await announceFirstPasskey(db, null, l);
    expect(l.lines).toHaveLength(1);
    expect(l.lines[0]).not.toMatch(/passkey\/register/);
    expect(await db.select().from(passkeyRegistrations)).toHaveLength(0);
  });
});

describe('admin passkey-link', () => {
  const env = () => ({ DATABASE_URL: inject('databaseUrl'), TABULA_TOKEN: TEST_TOKEN, TABULA_PUBLIC_URL: 'https://tabula.example.com' });

  it('prints a new link that replaces the earlier one', async () => {
    const earlier = await createRegistration(db, 'link', new Date());
    const out: string[] = [];
    expect(await runAdmin(['passkey-link'], env(), (l) => void out.push(l), () => {})).toBe(0);
    const token = /^https:\/\/tabula\.example\.com\/passkey\/register\/([A-Za-z0-9_-]{43})$/.exec(out[0]!)?.[1];
    expect(await findRegistration(db, token!, new Date())).toBeDefined();
    expect(await findRegistration(db, earlier, new Date())).toBeUndefined();
  });

  it('explains its usage and refuses without a public URL', async () => {
    const err: string[] = [];
    const out: string[] = [];
    expect(await runAdmin([], env(), () => {}, (l) => void err.push(l))).toBe(2);
    expect(err[0]).toBe('usage: node dist/admin.js passkey-link');
    expect(await runAdmin(['passkey-link'], { ...env(), TABULA_PUBLIC_URL: '' }, (l) => void out.push(l), (l) => void err.push(l))).toBe(1);
    expect(err[1]).toBe('TABULA_PUBLIC_URL is not set: passkeys are off, so there is nothing to register');
    expect(out).toEqual([]);
    expect(await db.select().from(passkeyRegistrations)).toHaveLength(0);
  });
});

import { api, ApiError } from '../api';
import { TimeAgo } from '../features/common';
import { PageHeader } from '../features/PageHeader';
import { useQuery } from '../hooks/data';
import { Alert, Badge, Button, Skeleton, useConfirm, useToast } from '../ui';

/** A passkey check that comes back here: the server's sign-in page accepts only a local path as `next`. */
const FRESH_SIGN_IN = `/signin?next=${encodeURIComponent('/#/security')}&reason=fresh`;

const needsFreshAuth = (e: unknown) => e instanceof ApiError && e.data.error === 'fresh_auth_required';
const RESOURCE_LABEL: Record<'mcp' | 'api' | 'app', string> = { mcp: 'MCP', api: 'REST API', app: 'App API' };

function Used({ iso, never }: { iso: string | null; never: string }) {
  return iso ? <>used <TimeAgo iso={iso} /></> : <>{never}</>;
}

export function SecurityPage() {
  const overview = useQuery((s) => api.security(s), []);
  const notify = useToast();
  const { confirm, prompt } = useConfirm();
  const data = overview.data;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      notify(done);
      overview.reload();
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };
  const rename = async (kind: 'passkey' | 'connection', id: string, current: string) => {
    const name = await prompt({ title: kind === 'passkey' ? 'Rename passkey' : 'Rename connection', label: 'Name', initial: current, confirmLabel: 'Rename', required: true });
    if (name === null || name.trim() === current) return;
    await act(() => (kind === 'passkey' ? api.renamePasskey(id, name.trim()) : api.renameConnection(id, name.trim())), 'Renamed');
  };
  /** The server asks for a passkey check from the last 5 minutes: offer it instead of a dead error. */
  const confirmWithPasskey = async () => {
    const message = 'Deleting a passkey needs a passkey check from the last 5 minutes.';
    if (await confirm({ title: 'Confirm with your passkey', message, confirmLabel: 'Continue' })) {
      window.location.assign(FRESH_SIGN_IN);
    }
  };

  if (overview.error) return <main className="content"><Alert tone="danger">{overview.error.message}</Alert></main>;
  if (!data) return <main className="content"><Skeleton height={320} /></main>;

  // Adding a passkey needs a passkey sign-in, and GET /passkey/add leads through it.
  const addPasskey = () => window.location.assign('/passkey/add');
  const deletePasskey = async (id: string, name: string) => {
    if (!data.fresh) return confirmWithPasskey();
    if (!(await confirm({ title: `Delete ${name}?`, message: 'It will no longer sign you in to Tabula.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.deletePasskey(id);
      notify('Passkey deleted');
      overview.reload();
    } catch (e) {
      if (needsFreshAuth(e)) return confirmWithPasskey();
      notify((e as Error).message, { tone: 'danger' });
    }
  };
  const revoke = async (id: string, name: string) => {
    if (await confirm({ title: `Revoke ${name}?`, message: 'The app loses access at once and has to connect again.', confirmLabel: 'Revoke', danger: true })) {
      await act(() => api.revokeConnection(id), 'Connection revoked');
    }
  };
  const signOut = async (id: string, device: string, current: boolean) => {
    const ok = await confirm(current
      ? { title: 'Sign out?', message: 'This browser signs out of Tabula. You sign in again with your passkey.', confirmLabel: 'Sign out' }
      : { title: `Sign out ${device}?`, message: 'That browser has to sign in again with a passkey.', confirmLabel: 'Sign out', danger: true });
    if (!ok) return;
    if (!current) return act(() => api.signOutSession(id), 'Session ended');
    try {
      await api.signOutSession(id);
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
      return;
    }
    // The server cleared the cookie: the reload lands on the sign-in screen.
    window.location.reload();
  };

  return (
    <main className="content">
      <PageHeader title="Security" description="How you and your apps sign in to Tabula." />

      <section className="t-card security-card" aria-labelledby="sec-passkeys">
        <h2 id="sec-passkeys">Passkeys</h2>
        <p className="t-subtle">Each passkey signs you in on its own: add one on your computer, one on your phone, or a security key.</p>
        {data.passkeys.map((k) => (
          <div key={k.id} className="security-row">
            <strong>{k.name}</strong>
            <span className="t-subtle">added <TimeAgo iso={k.createdAt} /> · <Used iso={k.lastUsedAt} never="never used" /></span>
            <span className="security-row__actions">
              <Button size="sm" onClick={() => void rename('passkey', k.id, k.name)}>Rename</Button>
              <Button
                size="sm"
                variant="danger"
                disabled={data.passkeys.length === 1}
                title={data.passkeys.length === 1 ? 'The last passkey cannot be deleted' : undefined}
                onClick={() => void deletePasskey(k.id, k.name)}
              >
                Delete
              </Button>
            </span>
          </div>
        ))}
        {data.passkeys.length === 1 && <p className="t-subtle">The last passkey cannot be deleted: add another one first.</p>}
        <div><Button icon="plus" onClick={addPasskey}>Add passkey</Button></div>
      </section>

      <section className="t-card security-card" aria-labelledby="sec-connections">
        <h2 id="sec-connections">App connections</h2>
        <p className="t-subtle">Apps you approved: Claude Code, claude.ai, the tabula command and others. The name labels what each one writes.</p>
        {data.connections.length === 0 && <p className="t-subtle">No app is connected.</p>}
        {data.connections.map((c) => (
          <div key={c.id} className="security-row">
            <strong className="t-mono">{c.name}</strong>
            <Badge tone="outline">{RESOURCE_LABEL[c.resource]}</Badge>
            {c.scope.split(' ').includes('inbox:read') && (
              <Badge tone="outline" title="May read the titles and status of Inbox messages in all projects, never their text">Inbox read</Badge>
            )}
            <span className="t-subtle" title="The app chose its name itself; it is not verified.">{c.app} · {c.target}</span>
            <span className="t-subtle">connected <TimeAgo iso={c.createdAt} /> · <Used iso={c.lastUsedAt} never="never used" /></span>
            <span className="security-row__actions">
              <Button size="sm" onClick={() => void rename('connection', c.id, c.name)}>Rename</Button>
              <Button size="sm" variant="danger" onClick={() => void revoke(c.id, c.name)}>Revoke</Button>
            </span>
          </div>
        ))}
      </section>

      <section className="t-card security-card" aria-labelledby="sec-sessions">
        <h2 id="sec-sessions">Signed-in browsers</h2>
        {data.sessions.length === 0 && <p className="t-subtle">No browser is signed in with a passkey.</p>}
        {data.sessions.map((s) => (
          <div key={s.id} className="security-row">
            <strong>{s.device}</strong>
            {s.current && <Badge tone="success">This browser</Badge>}
            <span className="t-subtle">signed in <TimeAgo iso={s.createdAt} /> · last active <TimeAgo iso={s.lastUsedAt} /></span>
            <span className="security-row__actions">
              <Button size="sm" onClick={() => void signOut(s.id, s.device, s.current)}>Sign out</Button>
            </span>
          </div>
        ))}
      </section>
    </main>
  );
}

import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { clearToken, fetchMe, fetchSession, getToken, setToken } from '../api';
import { Alert, Button, ButtonLink, Field, Input, LogoMark, Spinner } from '../ui';

type State = 'checking' | 'in' | 'out' | 'offline';

/** The app opens only for a signed-in browser: a passkey session (cookie) or, in this release, the legacy token. */
export function SignInGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>('checking');
  const [passkeySignIn, setPasskeySignIn] = useState(true);
  const check = async () => {
    setState('checking');
    try {
      // The session first: once a passkey works, the stored legacy token is dropped and never sent again.
      const session = await fetchSession();
      setPasskeySignIn(session.passkeySignIn);
      if (session.me) {
        clearToken();
        setState('in');
        return;
      }
      if (getToken() && (await fetchMe(true))) {
        setState('in');
        return;
      }
      clearToken();
      setState('out');
    } catch {
      setState('offline');
    }
  };
  useEffect(() => {
    void check();
  }, []);

  if (state === 'in') return <>{children}</>;
  return (
    <main className="gate">
      {state === 'checking' ? <Spinner /> : <SignInCard offline={state === 'offline'} passkeySignIn={passkeySignIn} onRetry={() => void check()} />}
    </main>
  );
}

function SignInCard({ offline, passkeySignIn, onRetry }: { offline: boolean; passkeySignIn: boolean; onRetry: () => void }) {
  const [draft, setDraft] = useState('');
  // Back to the same screen after the passkey: /signin accepts only a local path.
  const next = encodeURIComponent(`/${window.location.hash}`);
  const legacy = (e: FormEvent) => {
    e.preventDefault();
    setToken(draft.trim());
    window.location.reload();
  };
  return (
    <div className="gate__card t-card">
      <LogoMark size={44} />
      <div className="t-stack" style={{ gap: 6 }}>
        <h1>Sign in to Tabula</h1>
        <p className="t-muted">
          {passkeySignIn
            ? 'With a passkey on this device, on your phone or on a security key.'
            : 'Passkeys are not set up on this server (TABULA_PUBLIC_URL is not set). Sign in with the legacy token.'}
        </p>
      </div>
      {offline && (
        <Alert tone="danger">
          Tabula is not reachable right now. <Button size="sm" onClick={onRetry}>Try again</Button>
        </Alert>
      )}
      {passkeySignIn && <ButtonLink href={`/signin?next=${next}`} variant="primary" className="gate__wide">Sign in with passkey</ButtonLink>}
      <details className="gate__legacy" open={!passkeySignIn}>
        <summary>Sign in with legacy token</summary>
        <form className="t-stack" onSubmit={legacy}>
          <Field label="Token" hint={passkeySignIn ? 'TABULA_TOKEN from the server. It stays in this browser until you sign in with a passkey.' : 'TABULA_TOKEN from the server. It stays in this browser until you sign out.'}>
            {(id) => <Input id={id} type="password" autoComplete="current-password" value={draft} onChange={(e) => setDraft(e.target.value)} />}
          </Field>
          <Button type="submit" disabled={!draft.trim()} block>Sign in</Button>
        </form>
      </details>
      <p className="t-subtle"><a href="https://carnaby.github.io/tabula-mcp/" target="_blank" rel="noopener noreferrer">What is Tabula?</a></p>
    </div>
  );
}

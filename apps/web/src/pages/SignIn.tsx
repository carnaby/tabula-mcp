import { type ReactNode, useEffect, useState } from 'react';
import { fetchMe, forgetLegacyToken } from '../api';
import { Alert, Button, ButtonLink, LogoMark, Spinner } from '../ui';

type State = 'checking' | 'in' | 'out' | 'offline';

/** The app opens only for a browser signed in with a passkey (the session cookie). */
export function SignInGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>('checking');
  const check = async () => {
    setState('checking');
    try {
      forgetLegacyToken();
      setState((await fetchMe()) ? 'in' : 'out');
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
      {state === 'checking' ? <Spinner /> : <SignInCard offline={state === 'offline'} onRetry={() => void check()} />}
    </main>
  );
}

function SignInCard({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  // Back to the same screen after the passkey: /signin accepts only a local path.
  const next = encodeURIComponent(`/${window.location.hash}`);
  return (
    <div className="gate__card t-card">
      <LogoMark size={44} />
      <div className="t-stack" style={{ gap: 6 }}>
        <h1>Sign in to Tabula</h1>
        <p className="t-muted">With a passkey on this device, on your phone or on a security key.</p>
      </div>
      {offline && (
        <Alert tone="danger">
          Tabula is not reachable right now. <Button size="sm" onClick={onRetry}>Try again</Button>
        </Alert>
      )}
      <ButtonLink href={`/signin?next=${next}`} variant="primary" className="gate__wide">Sign in with passkey</ButtonLink>
      <p className="t-subtle"><a href="https://carnaby.github.io/tabula-mcp/" target="_blank" rel="noopener noreferrer">What is Tabula?</a></p>
    </div>
  );
}

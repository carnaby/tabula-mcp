import { type ReactNode, useState } from 'react';
import { getToken, setToken } from '../api';
import { Button, Field, Input, LogoMark } from '../ui';

export function TokenGate({ children }: { children: ReactNode }) {
  const [token, setTok] = useState(getToken());
  const [draft, setDraft] = useState('');
  if (token) return <>{children}</>;
  return (
    <main className="gate">
      <form
        className="gate__card t-card"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(draft.trim());
          setTok(draft.trim());
        }}
      >
        <LogoMark size={44} />
        <div className="t-stack" style={{ gap: 6 }}>
          <h1>Sign in to Tabula</h1>
          <p className="t-muted">Paste the bearer token from <code className="t-mono">TABULA_TOKEN</code>. It stays in this browser only.</p>
        </div>
        <Field label="Token">
          {(id) => <Input id={id} type="password" autoComplete="current-password" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />}
        </Field>
        <Button type="submit" variant="primary" disabled={!draft.trim()} block>Sign in</Button>
      </form>
    </main>
  );
}

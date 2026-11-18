import { useState } from 'react';
import { api } from '../../api';
import { copyText } from '../../format';
import { useQuery } from '../../hooks/data';
import type { Project } from '../../types';
import { Alert, Badge, Button, Field, Input, useConfirm, useToast } from '../../ui';
import { ProjectSelect, TimeAgo } from '../common';

/** Tokens that open one project's Inbox and nothing else. A new token's value is shown only here, only once. */
export function MessageTokens({ projects }: { projects: Project[] | undefined }) {
  const tokens = useQuery((s) => api.messageTokens(s), []);
  const notify = useToast();
  const { confirm } = useConfirm();
  const [project, setProject] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; value: string } | null>(null);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createMessageToken(project, name.trim());
      setCreated({ name: r.token.name, value: r.value });
      setName('');
      tokens.reload();
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string) => {
    if (await copyText(value)) notify('Copied');
    else notify('Copy failed; select the token and copy it by hand', { tone: 'danger' });
  };

  const revoke = async (id: string, tokenName: string) => {
    const ok = await confirm({ title: `Revoke ${tokenName}?`, message: 'Whatever uses this token loses access at once.', confirmLabel: 'Revoke', danger: true });
    if (!ok) return;
    try {
      await api.revokeMessageToken(id);
      tokens.reload();
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  return (
    <section className="t-card message-tokens" aria-labelledby="inbox-tokens">
      <h2 id="inbox-tokens">Inbox tokens</h2>
      <p className="t-subtle">A token lists the open messages of one project and can read any message of that project by its id. It can reply to open messages and set them In progress or Waiting. It opens nothing else in Tabula.</p>
      <div className="message-tokens__form">
        <Field label="Project">
          {(id) => <ProjectSelect id={id} projects={projects?.filter((p) => p.id !== 'global')} value={project} onChange={setProject} placeholder />}
        </Field>
        <Field label="Name">
          {(id) => <Input id={id} value={name} placeholder="reader" onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Button icon="plus" loading={busy} disabled={!project || !name.trim()} onClick={() => void create()}>Create token</Button>
      </div>
      {created && (
        <Alert tone="warn">
          <div className="t-stack">
            <strong>Copy the token for {created.name} now. It will not be shown again.</strong>
            <code className="t-mono message-tokens__value">{created.value}</code>
            <div>
              <Button size="sm" icon="copy" onClick={() => void copy(created.value)}>Copy</Button>{' '}
              <Button size="sm" onClick={() => setCreated(null)}>Done</Button>
            </div>
          </div>
        </Alert>
      )}
      {tokens.error && <Alert tone="danger">{tokens.error.message}</Alert>}
      {tokens.data?.map((t) => (
        <div key={t.id} className="message-tokens__row">
          <strong>{t.name}</strong>
          <Badge tone="outline" icon="folder">{t.project}</Badge>
          {t.revoked_at ? <Badge>Revoked</Badge> : <Badge tone="success">Active</Badge>}
          <span className="t-subtle">{t.last_used_at ? <>used <TimeAgo iso={t.last_used_at} /></> : 'never used'}</span>
          <span className="t-spacer" />
          {!t.revoked_at && <Button size="sm" onClick={() => void revoke(t.id, t.name)}>Revoke</Button>}
        </div>
      ))}
    </section>
  );
}

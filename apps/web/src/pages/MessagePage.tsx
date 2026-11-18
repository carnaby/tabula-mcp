import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { TimeAgo } from '../features/common';
import { CopyRefButton } from '../features/CopyRefButton';
import { EditorBar } from '../features/EditorBar';
import { MESSAGE_TONE, statusText } from '../features/inbox/InboxList';
import { PageHeader } from '../features/PageHeader';
import { invalidate, useQuery, useUnsavedGuard } from '../hooks/data';
import { backTarget, href, navigate } from '../router';
import {
  MESSAGE_STATUS_LABEL, MESSAGE_WAITING_LABEL, type MessageDetail, type MessageEvent, type MessagePatch, type Project,
} from '../types';
import { Alert, Badge, Button, ButtonLink, EmptyState, Field, IconButton, Markdown, Select, Skeleton, Textarea, useConfirm, useToast } from '../ui';

type Action = 'reply' | 'in_progress' | 'wait_author' | 'wait_sender' | 'done' | 'rejected';
/** What the owner picked, and on which version: a choice made on one state of the message says nothing about the next. */
type Choice = { action: Action; version: number };

const PATCH: Record<Action, Pick<MessagePatch, 'status' | 'waiting_on'>> = {
  reply: {},
  in_progress: { status: 'in_progress' },
  wait_author: { status: 'waiting', waiting_on: 'author' },
  wait_sender: { status: 'waiting', waiting_on: 'sender' },
  done: { status: 'done' },
  rejected: { status: 'rejected' },
};

const isClosed = (m: MessageDetail) => m.status === 'done' || m.status === 'rejected';

function actionsFor(m: MessageDetail): { value: Action | ''; label: string }[] {
  if (isClosed(m)) {
    return [
      { value: '', label: 'Choose how to reopen' },
      { value: 'in_progress', label: 'Reopen: in progress' },
      { value: 'wait_author', label: 'Reopen: waiting for you' },
      { value: 'wait_sender', label: 'Reopen: waiting for the sender' },
    ];
  }
  return [
    { value: 'reply', label: 'Keep the status' },
    ...(m.status !== 'in_progress' ? [{ value: 'in_progress' as const, label: 'In progress' }] : []),
    ...(m.waiting_on !== 'author' ? [{ value: 'wait_author' as const, label: 'Waiting for you' }] : []),
    ...(m.waiting_on !== 'sender' ? [{ value: 'wait_sender' as const, label: 'Waiting for the sender' }] : []),
    { value: 'done', label: 'Done' },
    { value: 'rejected', label: 'Rejected (needs a reason)' },
  ];
}

function eventText(e: MessageEvent): string {
  if (e.version === 1) return 'sent the message';
  if (!e.to_status) return 'replied';
  const target = e.to_status === 'waiting' && e.waiting_on ? `waiting for ${MESSAGE_WAITING_LABEL[e.waiting_on]}` : MESSAGE_STATUS_LABEL[e.to_status].toLowerCase();
  return `changed the status to ${target}`;
}

export function MessagePage({ id, from, projects }: { id: string; from?: string; projects: Project[] | undefined }) {
  const back = backTarget(from, href.inbox(), projects);
  const notify = useToast();
  const { confirm } = useConfirm();
  const [reply, setReply] = useState('');
  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const text = reply.trim();
  // While the owner is writing or has chosen, the message does not change under them when the window regains focus.
  const loaded = useQuery((s) => api.message(id, s), [id], { topics: ['messages'], refetchOnFocus: !text && !choice });
  const m = loaded.data;
  const error = loaded.error;
  const gone = error instanceof ApiError && error.status === 404;
  const guard = useUnsavedGuard(!!text && !gone);

  useEffect(() => {
    if (m && choice && choice.version !== m.version) setChoice(null);
  }, [m, choice]);

  if (gone || (error && !m)) {
    return (
      <main className="content">
        <EmptyState icon="alert" title={gone ? 'Message not found' : 'Could not load the message'} action={<ButtonLink href={back.href}>{back.label}</ButtonLink>}>
          {gone ? 'It may have been deleted.' : error?.message}
        </EmptyState>
      </main>
    );
  }
  if (!m) return <main className="content"><Skeleton height={36} width="50%" /><Skeleton height={240} /></main>;

  const closed = isClosed(m);
  const chosen = choice?.version === m.version ? choice.action : null;
  // Nothing is sent by default except the reply itself: a closed message waits for the owner's choice.
  const action: Action | '' = chosen ?? (closed ? '' : 'reply');
  const canSend = action === 'reply' || action === 'rejected' ? !!text : action !== '';

  const send = async () => {
    if (action === '') return;
    setBusy(true);
    try {
      await api.updateMessage(m.id, { expected_version: m.version, ...(text && { reply: text }), ...PATCH[action] });
      guard.current = false;
      setReply('');
      setChoice(null);
      invalidate('messages');
    } catch (e) {
      const changed = e instanceof ApiError && e.status === 409;
      notify(changed ? 'The message changed meanwhile. Look at it again; your text is kept.' : (e as Error).message, { tone: 'danger' });
      if (changed) loaded.reload();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({ title: 'Delete this message?', message: 'The message and its history are removed for good.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.deleteMessage(m.id);
      guard.current = false;
      setReply('');
      invalidate('messages');
      navigate(back.href);
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  return (
    <main className="content message-page">
      <EditorBar back={back} meta={<span className="t-subtle">Updated <TimeAgo iso={m.updated_at} /></span>}>
        <CopyRefButton id={m.id} />
        <IconButton icon="trash" label="Delete message" onClick={() => void remove()} />
      </EditorBar>

      <div className="t-stack">
        {error && <Alert tone="danger">Could not refresh this message, so it may be out of date: {error.message}</Alert>}
        <PageHeader title={m.title} chip={<Badge tone={MESSAGE_TONE[m.status]}>{statusText(m)}</Badge>} />
        <div className="report-card__meta">
          <span className="t-subtle">From (declared)</span>
          <Badge tone="outline" title="Declared by the sender, not verified">{m.from}</Badge>
          <span className="t-subtle">to</span>
          <Badge tone="outline" icon="folder">{m.to}</Badge>
          <Badge>{m.type === 'request' ? 'Request' : 'Report'}</Badge>
          {m.related_to && <a href={href.message(m.related_to)}>Related message</a>}
        </div>

        <div className="t-card message-body"><Markdown untrusted source={m.body} /></div>

        <h2>History</h2>
        <ol className="message-history">
          {m.events.map((e) => (
            <li key={e.version} className="t-card message-history__item">
              <div className="message-history__meta">
                <strong>{e.source === 'human' ? 'You' : e.actor}</strong>
                <span>{eventText(e)}</span>
                <span className="t-spacer" />
                <span className="t-subtle"><TimeAgo iso={e.at} /></span>
              </div>
              {e.reply && <Markdown untrusted source={e.reply} />}
            </li>
          ))}
        </ol>

        <section className="t-card message-reply" aria-label="Reply">
          {closed && <Alert>This message is closed. Reopen it to continue.</Alert>}
          <Field label="Reply">
            {(fid) => <Textarea id={fid} rows={4} value={reply} disabled={busy} onChange={(e) => setReply(e.target.value)} />}
          </Field>
          <div className="message-reply__actions">
            <Select
              aria-label="Status"
              value={action}
              onChange={(v) => setChoice(v === '' || v === 'reply' ? null : { action: v, version: m.version })}
              options={actionsFor(m)}
            />
            <Button variant="primary" icon="check" loading={busy} disabled={!canSend} onClick={() => void send()}>Save</Button>
          </div>
        </section>
      </div>
    </main>
  );
}

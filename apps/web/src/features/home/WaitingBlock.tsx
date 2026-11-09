import { fillCopyPrompt } from '@tabula/shared/copy-prompt';
import { useState } from 'react';
import { api, ApiError } from '../../api';
import { age, copyText, fullDate } from '../../format';
import { invalidate, useQuery } from '../../hooks/data';
import { href } from '../../router';
import type { Dashboard, Project, WaitingItem, WaitingTranscript } from '../../types';
import { Badge, type BadgeTone, Button, ButtonLink, Icon, IconButton, type IconName, Skeleton, useConfirm, useToast } from '../../ui';
import { closeReportMessage } from '../reports/closeReport';
import { CopyPromptDialog } from './CopyPromptDialog';
import { ProjectTag } from './ProjectTag';

const KIND: Record<WaitingItem['type'], { icon: IconName; label: string }> = {
  new_report: { icon: 'inbox', label: 'New report' },
  triaged: { icon: 'bot', label: 'Triaged' },
  transcription_failed: { icon: 'alert', label: 'Transcription failed' },
};

const TRANSCRIPT: Record<WaitingTranscript, { tone: BadgeTone; label: string }> = {
  done: { tone: 'success', label: 'Transcribed' },
  queued: { tone: 'neutral', label: 'Waiting for the worker' },
  running: { tone: 'info', label: 'Transcribing' },
  failed: { tone: 'danger', label: 'Transcription failed' },
};

/** Reports that wait for the user, oldest first, with what can be done about them right here. */
export function WaitingBlock({
  dashboard, projects, onChanged,
}: { dashboard: Dashboard | undefined; projects: Project[] | undefined; onChanged: () => void }) {
  const prompt = useQuery((s) => api.copyPrompt(s), []);
  const [editing, setEditing] = useState(false);
  // Until the saved text has loaded there is none: copying or editing the default would be the wrong text.
  const text = prompt.data?.text;
  const items = dashboard?.waiting;

  return (
    <section className="t-card home-block home-block--waiting" aria-labelledby="home-waiting">
      <div className="home-block__head">
        <h2 id="home-waiting">Waiting for you</h2>
        {items && items.length > 0 && <span className="home-block__count">{items.length}</span>}
        <span className="t-spacer" />
        {prompt.error && !text && <span className="t-subtle">The Copy for Claude text did not load.</span>}
        <IconButton size="sm" icon="gear" label="Copy for Claude text" disabled={text === undefined} onClick={() => setEditing(true)} />
      </div>
      {!dashboard ? (
        <div className="t-stack">{[0, 1].map((i) => <Skeleton key={i} height={52} />)}</div>
      ) : !items?.length ? (
        <p className="home-block__empty">Nothing waits for you.</p>
      ) : (
        <ul className="waiting-list">
          {items.map((w) => (
            <WaitingRow
              key={`${w.type}:${w.attachment_id ?? w.id}`}
              item={w}
              prompt={text}
              purgeAfterHours={dashboard.purge_after_hours}
              projects={projects}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      <CopyPromptDialog
        open={editing && text !== undefined}
        text={text ?? ''}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          prompt.reload();
        }}
      />
    </section>
  );
}

function WaitingRow({
  item: w, prompt, purgeAfterHours, projects, onChanged,
}: { item: WaitingItem; prompt: string | undefined; purgeAfterHours: number; projects: Project[] | undefined; onChanged: () => void }) {
  const notify = useToast();
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState(false);
  const kind = KIND[w.type];
  const open = w.type === 'transcription_failed' && w.attachment_id ? href.attachment(w.id, w.attachment_id, href.home()) : href.report(w.id, undefined, href.home());

  const copy = async () => {
    if (prompt === undefined) return;
    const text = fillCopyPrompt(prompt, w.ref);
    if (await copyText(text)) notify('Copied');
    else notify(`Copy failed — the text is: ${text}`, { tone: 'danger' });
  };

  const markDone = async () => {
    const ok = await confirm({
      title: 'Close this report?', message: closeReportMessage(w.recordings, w.keep_media, purgeAfterHours), confirmLabel: 'Close report',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.updateReport(w.id, { status: 'done', expectedVersion: w.version });
      invalidate('reports');
      notify('Report closed');
    } catch (e) {
      const changed = e instanceof ApiError && e.status === 409;
      notify(changed ? 'The report changed meanwhile, so it was not closed. Look at it again.' : (e as Error).message, { tone: 'danger' });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!w.attachment_id) return;
    setBusy(true);
    try {
      await api.retryTranscript(w.attachment_id);
      invalidate('reports');
      notify('Sent to the worker again');
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="waiting-row">
      <span className="waiting-row__icon" data-type={w.type}><Icon name={kind.icon} /></span>
      <div className="waiting-row__body">
        <a className="waiting-row__title" href={open}>{w.title}</a>
        <div className="waiting-row__meta">
          <span className="waiting-row__kind">{kind.label}</span>
          <ProjectTag id={w.project} projects={projects} />
          {w.type === 'new_report' && w.transcript && <Badge tone={TRANSCRIPT[w.transcript].tone}>{TRANSCRIPT[w.transcript].label}</Badge>}
          {w.type === 'transcription_failed' && <span className="t-subtle t-truncate" title={w.error ?? undefined}>{w.file_name}</span>}
          <time className="t-subtle t-nowrap" dateTime={w.since} title={fullDate(w.since)}>{age(w.since)}</time>
        </div>
      </div>
      <div className="waiting-row__actions">
        <ButtonLink size="sm" href={open}>Open</ButtonLink>
        {w.type === 'new_report' && <Button size="sm" icon="copy" disabled={prompt === undefined} onClick={() => void copy()}>Copy for Claude</Button>}
        {w.type === 'triaged' && <Button size="sm" icon="check" loading={busy} onClick={() => void markDone()}>Mark done</Button>}
        {w.type === 'transcription_failed' && <Button size="sm" icon="refresh" loading={busy} onClick={() => void retry()}>Try again</Button>}
      </div>
    </li>
  );
}

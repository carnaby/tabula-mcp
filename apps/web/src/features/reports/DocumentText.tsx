import { useState } from 'react';
import { api } from '../../api';
import { timeAgo } from '../../format';
import type { Attachment, DocumentState, DocumentTextView, WorkerStatus } from '../../types';
import { Alert, Button, Icon, Spinner, useToast } from '../../ui';
import { noteForPeople, progressText } from './fornaxText';

/** Text and Markdown files are read by Tabula itself; PDF and Office documents need Fornax. */
const isTextFile = (mime: string) => ['text/plain', 'text/markdown'].includes(mime.split(';')[0].trim().toLowerCase());

/** "Text · 3 pages · 1 tables · 1,234 characters": only what is known; cut when the text hit the limit. */
function summary(d: Extract<DocumentState, { status: 'done' }>): string {
  const parts = ['Text'];
  if (d.pages != null) parts.push(`${d.pages} pages`);
  if (d.tables != null) parts.push(`${d.tables} tables`);
  parts.push(`${d.characters.toLocaleString()} characters`);
  if (d.truncated) parts.push('cut at 1,000,000 characters');
  return parts.join(' · ');
}

/**
 * What became of a document's text, under its row: waiting for Fornax, being read, failed (Try again), or stored, with
 * Show text. The text is shown exactly as stored, as plain text: it comes from a stranger's file, never as Markdown.
 */
export function DocumentText({
  a, worker, onChange,
}: { a: Attachment; worker: WorkerStatus | undefined; onChange: (s: DocumentState) => void }) {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<DocumentTextView | null>(null);
  const d = a.document;
  if (!d) return null;

  const retry = async () => {
    setBusy(true);
    try {
      onChange(await api.retryDocument(a.id));
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  // The text is fetched once, on the first Show text; hiding and showing again reuses it.
  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    if (!text) {
      setBusy(true);
      try {
        setText(await api.documentText(a.id));
      } catch (e) {
        notify((e as Error).message, { tone: 'danger' });
        return;
      } finally {
        setBusy(false);
      }
    }
    setOpen(true);
  };

  switch (d.status) {
    case 'queued':
      return (
        <p className="doc-status transcript__note">
          <Icon name="inbox" />
          <span>
            Waiting for Fornax
            {noteForPeople(d.note) && ` — ${noteForPeople(d.note)}`}
            {d.retryAt && ` · next try ${timeAgo(d.retryAt)}`}
          </span>
        </p>
      );
    case 'running':
      return <p className="doc-status transcript__note"><Spinner /> Reading…{progressText(d)}</p>;
    case 'failed':
      return (
        <div className="doc-status transcript__note">
          <Alert tone="danger">Reading failed{d.error ? `: ${d.error}` : ''}</Alert>
          {a.url && <Button size="sm" icon="refresh" loading={busy} onClick={() => void retry()}>Try again</Button>}
        </div>
      );
    case 'done':
      if (d.characters === 0) return <p className="doc-status transcript__note">No text found in the document</p>;
      return (
        <>
          <p className="doc-status transcript__note">
            {summary(d)}
            <Button size="sm" icon="fileText" loading={busy} aria-expanded={open} onClick={() => void toggle()}>{open ? 'Hide text' : 'Show text'}</Button>
          </p>
          {open && text && <pre className="doc-text" tabIndex={0} aria-label={`Text of ${a.fileName}`}>{text.text}</pre>}
        </>
      );
    case 'none':
      if (!isTextFile(a.mime) && worker && !worker.enabled) {
        return <p className="doc-status transcript__note"><Icon name="inbox" /> Reading PDF and Office documents is not enabled on this server.</p>;
      }
      return (
        <p className="doc-status transcript__note">
          Not read.
          {a.url && <Button size="sm" icon="fileText" loading={busy} onClick={() => void retry()}>Read text</Button>}
        </p>
      );
  }
}

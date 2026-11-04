import { useState } from 'react';
import { api } from '../../api';
import { timeAgo } from '../../format';
import type { Attachment, TranscriptState, WorkerStatus } from '../../types';
import { Alert, Button, Icon, Spinner, useToast } from '../../ui';
import { clock } from './Recorder';

/** A worker that called in this recently is running: while it waits for work it calls every 30 s. */
export const WORKER_ALIVE_MS = 2 * 60 * 1000;
export const workerAlive = (w: WorkerStatus | undefined, now = Date.now()): boolean =>
  !!w?.lastSeenAt && now - Date.parse(w.lastSeenAt) < WORKER_ALIVE_MS;

/** The transcript under a video or voice note: lines with clickable times, or what it is waiting for. */
export function Transcript({
  a, worker, onSeek, onChange,
}: {
  a: Attachment;
  worker: WorkerStatus | undefined;
  /** Moves the player to a moment; absent when the recording was deleted. */
  onSeek?: (ms: number) => void;
  onChange: (t: TranscriptState) => void;
}) {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const t = a.transcript;
  if (!t) return null;

  const retry = async () => {
    setBusy(true);
    try {
      onChange(await api.retryTranscript(a.id));
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (t.status === 'done') {
    if (!t.segments.length) return <p className="transcript__note">No speech in the recording.</p>;
    return (
      <ol className="transcript" aria-label="Transcript">
        {t.segments.map((s, i) => (
          <li key={i} className="transcript__line">
            {onSeek ? (
              <button type="button" className="transcript__time" title={`Play from ${clock(s.start_ms)}`} onClick={() => onSeek(s.start_ms)}>
                {clock(s.start_ms)}
              </button>
            ) : (
              <span className="transcript__time">{clock(s.start_ms)}</span>
            )}
            <span>{s.text}</span>
          </li>
        ))}
      </ol>
    );
  }
  if (t.status === 'running') {
    return <p className="transcript__note"><Spinner /> Transcribing…</p>;
  }
  if (t.status === 'failed') {
    return (
      <div className="transcript__note">
        <Alert tone="danger">Transcription failed{t.error ? `: ${t.error}` : ''}</Alert>
        {a.url && <Button size="sm" icon="refresh" loading={busy} onClick={() => void retry()}>Try again</Button>}
      </div>
    );
  }
  if (t.status === 'none') {
    if (!a.url) return null;
    return (
      <p className="transcript__note">
        Not transcribed.
        <Button size="sm" icon="mic" loading={busy} onClick={() => void retry()}>Transcribe</Button>
      </p>
    );
  }
  const alive = workerAlive(worker);
  return (
    <p className="transcript__note">
      <Icon name="inbox" />
      <span>
        Waiting for transcription
        {worker && (worker.lastSeenAt ? ` — worker last seen ${timeAgo(worker.lastSeenAt)}` : ' — the worker has never connected')}
        {t.retryAt && ` · next try ${timeAgo(t.retryAt)}`}
        {!alive && <> · start it on your PC: <code>tabula worker --once</code></>}
      </span>
    </p>
  );
}

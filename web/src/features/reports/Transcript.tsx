import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { timeAgo } from '../../format';
import type { Attachment, TranscriptState, WorkerStatus } from '../../types';
import { Alert, Button, Icon, Spinner, useToast } from '../../ui';
import { clock } from './Recorder';

/** A worker that called in this recently is running: while it waits for work it calls every 30 s. */
export const WORKER_ALIVE_MS = 2 * 60 * 1000;
export const workerAlive = (w: WorkerStatus | undefined, now = Date.now()): boolean =>
  !!w?.lastSeenAt && now - Date.parse(w.lastSeenAt) < WORKER_ALIVE_MS;

/** After the user scrolls or touches the transcript, playback leaves it alone this long. */
const USER_SCROLL_PAUSE_MS = 4000;

/** Index of the last line that has started at `ms`; -1 before the first one. */
export function activeLine(segments: { start_ms: number }[], ms: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start_ms <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The transcript under a video or voice note: lines with clickable times, or what it is waiting for. */
export function Transcript({
  a, worker, onSeek, onChange, currentMs, playing = false,
}: {
  a: Attachment;
  worker: WorkerStatus | undefined;
  /** Moves the player to a moment; absent when the recording was deleted. */
  onSeek?: (ms: number) => void;
  onChange: (t: TranscriptState) => void;
  /** Playback position; the line being spoken is highlighted. */
  currentMs?: number;
  /** While true, the transcript scrolls to keep the active line in view. */
  playing?: boolean;
}) {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const lastUserAction = useRef(0);
  const t = a.transcript;
  const segments = t?.status === 'done' ? t.segments : null;
  const active = useMemo(
    () => (segments && currentMs !== undefined ? activeLine(segments, currentMs) : -1),
    [segments, currentMs],
  );

  // Follow playback inside the transcript's own scroll container (never scrollIntoView: it scrolls the page too).
  useEffect(() => {
    const list = listRef.current;
    if (!playing || active < 0 || !list) return;
    if (Date.now() - lastUserAction.current < USER_SCROLL_PAUSE_MS) return;
    const line = list.children[active] as HTMLElement | undefined;
    if (!line) return;
    const offset = line.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const top = Math.max(0, list.scrollTop + offset - (list.clientHeight - line.offsetHeight) / 2);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    list.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
  }, [active, playing]);

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
      <ol
        ref={listRef}
        className="transcript"
        aria-label="Transcript"
        onWheel={() => { lastUserAction.current = Date.now(); }}
        onTouchStart={() => { lastUserAction.current = Date.now(); }}
        onPointerDown={() => { lastUserAction.current = Date.now(); }}
      >
        {t.segments.map((s, i) => (
          <li key={i} className="transcript__line" data-active={i === active || undefined}>
            {onSeek ? (
              <button type="button" className="transcript__time" title={`Play from ${clock(s.start_ms)}`} aria-label={`Play from ${clock(s.start_ms)}`} onClick={() => onSeek(s.start_ms)}>
                {clock(s.start_ms)}
              </button>
            ) : (
              <span className="transcript__time">{clock(s.start_ms)}</span>
            )}
            <span className="transcript__text">{s.text}</span>
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
  if (worker && !worker.enabled) {
    return <p className="transcript__note"><Icon name="inbox" /> Transcription is not enabled on this server.</p>;
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

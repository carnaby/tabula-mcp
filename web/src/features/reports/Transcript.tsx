import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { timeAgo } from '../../format';
import type { Attachment, SpeakerName, TranscriptSegment, TranscriptState, WorkerStatus } from '../../types';
import { Alert, Button, Icon, Popover, Spinner, useConfirm, useToast } from '../../ui';
import { clock } from './Recorder';
import { SpeakerChip } from './Speakers';

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

/** What the lines need to show speakers; one object for all lines, so memoized lines stay memoized while the player ticks. */
type Speakers = { attachmentId: string; reportId: string; names: Record<string, SpeakerName>; locked: boolean; onSaved: (t: TranscriptState) => void };

/** One line; `chip`: the speaker changes here, so the line shows the speaker's label. */
const Line = memo(function Line({
  s, active, onSeek, speakers, chip,
}: { s: TranscriptSegment; active: boolean; onSeek?: (ms: number) => void; speakers: Speakers | null; chip: boolean }) {
  return (
    <li className="transcript__line" data-active={active || undefined}>
      {onSeek ? (
        <button type="button" className="transcript__time" title={`Play from ${clock(s.start_ms)}`} aria-label={`Play from ${clock(s.start_ms)}`} onClick={() => onSeek(s.start_ms)}>
          {clock(s.start_ms)}
        </button>
      ) : (
        <span className="transcript__time">{clock(s.start_ms)}</span>
      )}
      {speakers && (
        <span className="transcript__speaker">
          {chip && s.speaker && (
            <SpeakerChip id={s.speaker} entry={speakers.names[s.speaker]} attachmentId={speakers.attachmentId} reportId={speakers.reportId} onSaved={speakers.onSaved} locked={speakers.locked} />
          )}
        </span>
      )}
      <span className="transcript__text">{s.text}</span>
    </li>
  );
});

/** The "⋯" menu above a transcript. */
function TranscriptMenu({ onAgain }: { onAgain: () => void }) {
  return (
    <Popover className="transcript__menu" triggerClassName="transcript__menu-trigger" triggerLabel="Transcript options" trigger={<Icon name="more" />}>
      {(close) => (
        <button type="button" className="t-popover__item" onClick={() => { close(); onAgain(); }}>
          <Icon name="refresh" /> Transcribe again
        </button>
      )}
    </Popover>
  );
}

/** The transcript under a video or voice note: lines with clickable times (and speakers), or what it is waiting for. */
export function Transcript({
  a, worker, onSeek, onChange, currentMs, playing = false, closed = false,
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
  /** The report is closed: no "Transcribe again". */
  closed?: boolean;
}) {
  const notify = useToast();
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const lastUserAction = useRef(0);
  // The parent passes a new function on every render (the player ticks); the lines get one that never changes.
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const onSaved = useCallback((s: TranscriptState) => changeRef.current(s), []);
  const t = a.transcript;
  const done = t?.status === 'done' ? t : null;
  const segments = done ? done.segments : null;
  const active = useMemo(
    () => (segments && currentMs !== undefined ? activeLine(segments, currentMs) : -1),
    [segments, currentMs],
  );
  const several = !!done?.diarization && 'speakers' in done.diarization && done.diarization.speakers > 1;
  const names = done?.speakers;
  const locked = t?.status === 'done' && (t.again?.status === 'queued' || t.again?.status === 'running');
  const speakers = useMemo<Speakers | null>(
    () => (several && names ? { attachmentId: a.id, reportId: a.reportId, names, locked, onSaved } : null),
    [several, names, locked, a.id, a.reportId, onSaved],
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

  const again = async () => {
    const ok = await confirm({
      title: 'Transcribe again?',
      message: 'The worker transcribes the recording again and replaces this transcript when it is done. The speaker names are cleared, because a new run may number the speakers differently.',
      confirmLabel: 'Transcribe again',
    });
    if (!ok) return;
    try {
      onChange(await api.transcribeAgain(a.id));
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  if (t.status === 'done') {
    const pending = t.again;
    const canAgain = !!a.url && !closed && pending?.status !== 'queued' && pending?.status !== 'running';
    const notRecognized = t.diarization && 'error' in t.diarization ? t.diarization.error : null;
    return (
      <div className="transcript-block">
        {canAgain && <div className="transcript__head"><TranscriptMenu onAgain={() => void again()} /></div>}
        {t.segments.length ? (
          <ol
            ref={listRef}
            className="transcript"
            aria-label="Transcript"
            data-speakers={speakers ? true : undefined}
            onWheel={() => { lastUserAction.current = Date.now(); }}
            onTouchStart={() => { lastUserAction.current = Date.now(); }}
            onPointerDown={() => { lastUserAction.current = Date.now(); }}
          >
            {t.segments.map((s, i) => (
              <Line key={i} s={s} active={i === active} onSeek={onSeek} speakers={speakers} chip={!!speakers && s.speaker !== t.segments[i - 1]?.speaker} />
            ))}
          </ol>
        ) : (
          <p className="transcript__note">No speech in the recording.</p>
        )}
        {notRecognized && <p className="transcript__note transcript__note--quiet">Speakers not recognized: {notRecognized}</p>}
        {pending?.status === 'queued' && (
          <p className="transcript__note"><Icon name="inbox" /> Waiting to transcribe again; this transcript stays until the new one is ready.</p>
        )}
        {pending?.status === 'running' && <p className="transcript__note"><Spinner /> Transcribing again…</p>}
        {pending?.status === 'failed' && (
          <div className="transcript__note">
            <Alert tone="danger">Transcribing again failed{pending.error ? `: ${pending.error}` : ''}</Alert>
            {a.url && <Button size="sm" icon="refresh" loading={busy} onClick={() => void retry()}>Try again</Button>}
          </div>
        )}
      </div>
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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { timeAgo } from '../../format';
import type { Attachment, SpeakerName, TranscriptSegment, TranscriptState, WorkerStatus } from '../../types';
import { Alert, Button, cx, Icon, Popover, Select, Spinner, Textarea, useConfirm, useToast } from '../../ui';
import { clock } from './Recorder';
import { SpeakerChip } from './Speakers';

/** A worker that called in this recently is running: while it waits for work it calls every 30 s. */
export const WORKER_ALIVE_MS = 2 * 60 * 1000;
export const workerAlive = (w: WorkerStatus | undefined, now = Date.now()): boolean =>
  !!w?.lastSeenAt && now - Date.parse(w.lastSeenAt) < WORKER_ALIVE_MS;

/** After the user scrolls or touches the transcript, playback leaves it alone this long. */
const USER_SCROLL_PAUSE_MS = 4000;
/** The server's limit on one line. */
const LINE_MAX = 2000;

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

/**
 * One line; `chip`: the speaker changes here, so the line shows the speaker's label. The pencil at its end opens the
 * editor; it shows on hover, or after a tap on the line's text (`shown`, for touch screens).
 */
const Line = memo(function Line({
  s, index, active, onSeek, speakers, chip, shown, onShow, onEdit, locked,
}: {
  s: TranscriptSegment;
  index: number;
  active: boolean;
  onSeek?: (ms: number) => void;
  speakers: Speakers | null;
  chip: boolean;
  shown: boolean;
  onShow: (index: number) => void;
  onEdit: (index: number) => void;
  /** The recording is being transcribed again: the line cannot be edited until the new transcript is in. */
  locked: boolean;
}) {
  const by = s.edit?.by;
  const edited = by === 'user' ? 'Edited by you' : 'Edited by Claude';
  return (
    <li className="transcript__line" data-active={active || undefined} data-shown={shown || undefined}>
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
      <span className={cx('transcript__text', by === 'agent' && 'transcript__text--agent')} onClick={() => onShow(index)}>
        {s.text}
        {by && (
          <span className="transcript__edited" title={edited} role="img" aria-label={edited}>
            <Icon name="pencil" />
          </span>
        )}
      </span>
      {!locked && (
        <button type="button" className="transcript__edit" title="Edit this line" aria-label={`Edit the line at ${clock(s.start_ms)}`} onClick={() => onEdit(index)}>
          <Icon name="pencil" />
        </button>
      )}
    </li>
  );
});

/** A line being corrected: its text, its speaker (when the recording has several), and Save / Cancel / Restore original. */
function LineEditor({
  attachmentId, index, s, speakerIds, names, onSaved, onStale, onClose,
}: {
  attachmentId: string;
  index: number;
  s: TranscriptSegment;
  speakerIds: string[];
  names: Record<string, SpeakerName>;
  onSaved: (t: TranscriptState) => void;
  /** The server's current line after a 409: the transcript shows it too, so Cancel leaves no stale row. */
  onStale: (line: TranscriptSegment) => void;
  onClose: () => void;
}) {
  const notify = useToast();
  const [text, setText] = useState(s.text);
  const [speaker, setSpeaker] = useState(s.speaker ?? '');
  // The line as the user last saw it: the server refuses the save (409) when its line differs.
  const [seen, setSeen] = useState<TranscriptSegment>(s);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const speakerLabel = (id: string) => (names[id] ? `${id} · ${names[id].name}` : id);

  const save = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      onSaved(await api.editSegment(attachmentId, index, {
        text,
        // Only a speaker the user picked: a transcript without diarization refuses any speaker, even its own.
        ...(speaker && speaker !== (seen.speaker ?? '') ? { speaker } : {}),
        expected: { text: seen.text, speaker: seen.speaker ?? null },
      }));
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data.current) {
        // Show what is there now; the draft stays, and the next Save replaces that line on purpose.
        const current = e.data.current as TranscriptSegment;
        // A speaker the user left alone follows the line's current one.
        if (speaker === (seen.speaker ?? '')) setSpeaker(current.speaker ?? '');
        setSeen(current);
        setChanged(true);
        onStale(current);
      } else {
        notify((e as Error).message, { tone: 'danger' });
      }
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (busy) return;
    setBusy(true);
    try {
      onSaved(await api.restoreSegment(attachmentId, index));
      onClose();
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="transcript__line transcript__line--editing">
      <div className="line-editor">
        <span className="transcript__time">{clock(s.start_ms)}</span>
        {changed && (
          <Alert tone="warn">
            This line changed meanwhile. Now: “{seen.text}”{seen.speaker ? ` (${speakerLabel(seen.speaker)})` : ''}. Save replaces it with your text.
          </Alert>
        )}
        <Textarea
          ref={input}
          rows={2}
          maxLength={LINE_MAX}
          value={text}
          aria-label={`Text of the line at ${clock(s.start_ms)}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Keys that commit or cancel an input method's composition belong to it.
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              // One line of a transcript: Enter saves, Shift+Enter adds no line break.
              e.preventDefault();
              if (!e.shiftKey) void save();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <div className="line-editor__row">
          {speakerIds.length > 0 && (
            <Select
              size="sm"
              aria-label="Speaker"
              value={speaker}
              onChange={setSpeaker}
              options={[...(speaker ? [] : [{ value: '', label: 'No speaker' }]), ...speakerIds.map((id) => ({ value: id, label: speakerLabel(id) }))]}
            />
          )}
          <span className="t-spacer" />
          {seen.edit && <Button size="sm" icon="undo" disabled={busy} onClick={() => void restore()}>Restore original</Button>}
          <span className="line-editor__actions">
            <Button size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button size="sm" variant="primary" icon="check" loading={busy} disabled={!text.trim()} onClick={() => void save()}>Save</Button>
          </span>
        </div>
      </div>
    </li>
  );
}

/** "Transcribe again" of a recording: whether it is allowed now, and the confirmed action. Used by the card's menu. */
export function useTranscribeAgain(a: Attachment, closed: boolean, onChange: (t: TranscriptState) => void) {
  const notify = useToast();
  const { confirm } = useConfirm();
  const t = a.transcript;
  const canAgain = !!a.url && !closed && t?.status === 'done' && t.again?.status !== 'queued' && t.again?.status !== 'running';
  const again = async () => {
    const edited = t?.status === 'done' ? t.segments.filter((s) => s.edit).length : 0;
    const lost = edited ? ` ${edited} edited line${edited === 1 ? '' : 's'} will be lost.` : '';
    const ok = await confirm({
      title: 'Transcribe again?',
      message: `The worker transcribes the recording again and replaces this transcript when it is done. The speaker names are cleared, because a new run may number the speakers differently.${lost}`,
      confirmLabel: 'Transcribe again',
    });
    if (!ok) return;
    try {
      onChange(await api.transcribeAgain(a.id));
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };
  return { canAgain, again };
}

/** The "⋯" menu in the caption of a video or voice note: Transcribe again (when allowed) and Delete. */
export function RecordingMenu({
  a, closed = false, onChange, deleteLabel, onDelete,
}: { a: Attachment; closed?: boolean; onChange: (t: TranscriptState) => void; deleteLabel: string; onDelete: () => void }) {
  const { canAgain, again } = useTranscribeAgain(a, closed, onChange);
  return (
    <Popover fixed align="end" className="rec-menu" triggerClassName="rec-menu__trigger" triggerLabel="Recording options" trigger={<Icon name="more" />}>
      {(close) => (
        <>
          {canAgain && (
            <button type="button" className="t-popover__item" onClick={() => { close(); void again(); }}>
              <Icon name="refresh" /> Transcribe again
            </button>
          )}
          <button type="button" className="t-popover__item t-popover__item--danger" onClick={() => { close(); onDelete(); }}>
            <Icon name="trash" /> {deleteLabel}
          </button>
        </>
      )}
    </Popover>
  );
}

/** The transcript under a video or voice note: lines with clickable times (and speakers), or what it is waiting for. */
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
  const [editing, setEditing] = useState<number | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const lastUserAction = useRef(0);
  // The parent passes a new function on every render (the player ticks); the lines get one that never changes.
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const onSaved = useCallback((s: TranscriptState) => changeRef.current(s), []);
  const onEdit = useCallback((i: number) => {
    setEditing(i);
    setShown(null);
  }, []);
  const onShow = useCallback((i: number) => setShown((cur) => (cur === i ? null : i)), []);
  const closeEditor = useCallback(() => setEditing(null), []);
  const t = a.transcript;
  // The transcript as last rendered, for a 409 that answers after the player ticked (or a new transcript came in).
  const transcriptRef = useRef(t);
  transcriptRef.current = t;
  const onStale = useCallback((i: number, line: TranscriptSegment) => {
    const cur = transcriptRef.current;
    if (cur?.status !== 'done' || !cur.segments[i]) return;
    changeRef.current({ ...cur, segments: cur.segments.map((x, j) => (j === i ? line : x)) });
  }, []);
  const done = t?.status === 'done' ? t : null;
  const segments = done ? done.segments : null;
  const active = useMemo(
    () => (segments && currentMs !== undefined ? activeLine(segments, currentMs) : -1),
    [segments, currentMs],
  );
  const diarization = done?.diarization;
  const several = !!diarization && 'speakers' in diarization && diarization.speakers > 1;
  const names = done?.speakers;
  const locked = t?.status === 'done' && (t.again?.status === 'queued' || t.again?.status === 'running');
  const speakers = useMemo<Speakers | null>(
    () => (several && names ? { attachmentId: a.id, reportId: a.reportId, names, locked, onSaved } : null),
    [several, names, locked, a.id, a.reportId, onSaved],
  );
  // The speakers a line may get in the editor: S1 … Sn, only when the recording has several (like the chips).
  const speakerIds = useMemo(
    () => (several && diarization && 'speakers' in diarization ? Array.from({ length: diarization.speakers }, (_, i) => `S${i + 1}`) : []),
    [several, diarization],
  );

  // A new transcript (transcribed again) may have fewer lines: an editor past its end closes.
  useEffect(() => {
    if (editing !== null && (!segments || editing >= segments.length)) setEditing(null);
  }, [segments, editing]);
  // Transcribing again replaces the lines: an open editor closes, and none opens until the new transcript is in.
  useEffect(() => {
    if (locked) setEditing(null);
  }, [locked]);

  // A closed editor takes the focus with it; it goes back to the line's pencil, so the keyboard stays where it was.
  const lastEditing = useRef<number | null>(null);
  useEffect(() => {
    const closed = lastEditing.current;
    lastEditing.current = editing;
    if (editing !== null || closed === null) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    listRef.current?.children[closed]?.querySelector<HTMLElement>('.transcript__edit')?.focus({ preventScroll: true });
  }, [editing]);

  // Follow playback inside the transcript's own scroll container (never scrollIntoView: it scrolls the page too).
  // While a line is being edited the transcript stays where it is.
  useEffect(() => {
    const list = listRef.current;
    if (!playing || active < 0 || !list || editing !== null) return;
    if (Date.now() - lastUserAction.current < USER_SCROLL_PAUSE_MS) return;
    const line = list.children[active] as HTMLElement | undefined;
    if (!line) return;
    const offset = line.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const top = Math.max(0, list.scrollTop + offset - (list.clientHeight - line.offsetHeight) / 2);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    list.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
  }, [active, playing, editing]);

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
    const pending = t.again;
    const notRecognized = t.diarization && 'error' in t.diarization ? t.diarization.error : null;
    return (
      <div className="transcript-block">
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
            {t.segments.map((s, i) =>
              i === editing && !locked ? (
                <LineEditor key={i} attachmentId={a.id} index={i} s={s} speakerIds={speakerIds} names={t.speakers} onSaved={onSaved} onStale={(line) => onStale(i, line)} onClose={closeEditor} />
              ) : (
                <Line
                  key={i}
                  s={s}
                  index={i}
                  active={i === active}
                  onSeek={onSeek}
                  speakers={speakers}
                  chip={!!speakers && s.speaker !== t.segments[i - 1]?.speaker}
                  shown={i === shown}
                  onShow={onShow}
                  onEdit={onEdit}
                  locked={locked}
                />
              ),
            )}
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

import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { formatSize } from '../../format';
import type { Attachment, TranscriptState, WorkerStatus } from '../../types';
import { Badge, Button, Icon, IconButton, Textarea, useConfirm, useToast } from '../../ui';
import { clock } from './Recorder';
import { Transcript } from './Transcript';
import type { Upload } from './uploads';

/** Jump the player to a moment of the transcript and play from there. */
function seek(media: HTMLMediaElement | null, ms: number) {
  if (!media) return;
  media.currentTime = ms / 1000;
  void media.play().catch(() => {});
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  media.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
}

const NOTE_MAX = 2000;

/** The user's note on a saved frame: saved on blur and on Ctrl/Cmd+Enter, when it changed. */
function FrameNote({ frame, onSaved }: { frame: Attachment; onSaved: (f: Attachment) => void }) {
  const notify = useToast();
  const [draft, setDraft] = useState(frame.note ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const latest = useRef(draft);
  latest.current = draft;
  // The last value known to be on the server, and whether a save is under way (with a change waiting behind it).
  const savedRef = useRef(frame.note ?? '');
  const inFlight = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    if (state !== 'saved') return;
    const h = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(h);
  }, [state]);
  const save = async (): Promise<void> => {
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    const sent = latest.current.trim();
    if (sent === savedRef.current) return;
    inFlight.current = true;
    setState('saving');
    try {
      const f = await api.setFrameNote(frame.id, sent || null);
      savedRef.current = f.note ?? '';
      onSaved({ ...frame, note: f.note });
      // Text typed while the request was under way stays.
      if (latest.current.trim() === sent) setDraft(f.note ?? '');
      setState('saved');
    } catch (e) {
      setState('idle');
      pending.current = false;
      notify((e as Error).message, { tone: 'danger' });
    } finally {
      inFlight.current = false;
    }
    if (pending.current) {
      pending.current = false;
      await save();
    }
  };
  return (
    <div className="att__note">
      <span className="att__note-state t-subtle" role="status">{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : ' '}</span>
      <Textarea
        rows={2}
        maxLength={NOTE_MAX}
        value={draft}
        placeholder={`Note — what the video doesn't say (frame at ${clock(frame.atMs ?? 0)})`}
        aria-label={`Note on the frame at ${clock(frame.atMs ?? 0)}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
          </div>
  );
}

function VideoCard({
  a, frames, worker, onFrame, onTranscript, onDelete, onDeleteFrame, onNote,
}: {
  a: Attachment;
  frames: Attachment[];
  worker: WorkerStatus | undefined;
  onFrame: (f: Attachment) => void;
  onTranscript: (t: TranscriptState) => void;
  onDelete: () => void;
  onDeleteFrame: (f: Attachment) => void;
  onNote: (f: Attachment) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [busy, setBusy] = useState(false);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Derived, so a deleted frame is no longer selected.
  const selected = frames.find((f) => f.id === selectedId) ?? null;
  const notify = useToast();
  const onSeek = useCallback((ms: number) => seek(ref.current, ms), []);
  return (
    <figure className="att att--wide">
      {a.url ? (
        <video ref={ref} className="att__media" src={a.url} controls playsInline preload="metadata" onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      ) : (
        <div className="att__gone"><Icon name="film" /> Video deleted after the report was closed</div>
      )}
      <figcaption className="att__cap">
        <span className="t-truncate">{a.fileName}</span>
        <span className="t-subtle t-nowrap">{a.durationMs !== null ? clock(a.durationMs) : ''} · {formatSize(a.size)}</span>
        {a.url && (
          <Button
            size="sm"
            icon="aperture"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const f = await api.saveFrame(a.id, Math.round(t * 10) / 10);
                onFrame(f);
                notify(`Frame at ${clock(f.atMs ?? 0)} saved`);
              } catch (e) {
                notify((e as Error).message, { tone: 'danger' });
              } finally {
                setBusy(false);
              }
            }}
          >
            Save frame {clock(t * 1000)}
          </Button>
        )}
        <span className="t-spacer" />
        <IconButton size="sm" icon="trash" label="Delete video" onClick={onDelete} />
      </figcaption>
      {frames.length > 0 && (
        <div className="att__frames">
          {frames.map((f) => (
            <div key={f.id} className="att__frame-wrap">
              <button
                type="button"
                className="att__frame"
                data-selected={f.id === selected?.id || undefined}
                aria-pressed={f.id === selected?.id}
                title={`Play from ${clock(f.atMs ?? 0)}`}
                onClick={() => {
                  setSelectedId(f.id);
                  if (ref.current) seek(ref.current, f.atMs ?? 0);
                  else if (f.url) window.open(f.url, '_blank', 'noopener');
                }}
              >
                {f.url && <img src={f.url} alt={`Frame at ${clock(f.atMs ?? 0)}`} loading="lazy" />}
                <span>{clock(f.atMs ?? 0)}</span>
              </button>
              {f.note && <span className="att__frame-note" title="Has a note" role="img" aria-label="Has a note"><Icon name="pencil" /></span>}
              {f.id === selected?.id && (
                <IconButton size="sm" variant="danger-solid" className="att__frame-del" icon="trash" label="Delete frame" onClick={() => onDeleteFrame(f)} />
              )}
            </div>
          ))}
        </div>
      )}
      {selected && <FrameNote key={selected.id} frame={selected} onSaved={onNote} />}
      <Transcript a={a} worker={worker} onSeek={a.url ? onSeek : undefined} onChange={onTranscript} currentMs={t * 1000} playing={playing} />
    </figure>
  );
}

function AudioCard({
  a, worker, onTranscript, onDelete,
}: { a: Attachment; worker: WorkerStatus | undefined; onTranscript: (t: TranscriptState) => void; onDelete: () => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const onSeek = useCallback((ms: number) => seek(ref.current, ms), []);
  return (
    <figure className="att att--wide">
      {a.url ? (
        <audio ref={ref} className="att__audio" src={a.url} controls preload="metadata" onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      ) : (
        <div className="att__gone"><Icon name="mic" /> Voice note deleted after the report was closed</div>
      )}
      <figcaption className="att__cap">
        {a.createdBy !== 'human' && <Badge icon="bot">{a.createdBy}</Badge>}
        <span className="t-truncate">{a.fileName}</span>
        <span className="t-subtle t-nowrap">{a.durationMs !== null ? `${clock(a.durationMs)} · ` : ''}{formatSize(a.size)}</span>
        <span className="t-spacer" />
        <IconButton size="sm" icon="trash" label="Delete voice note" onClick={onDelete} />
      </figcaption>
      <Transcript a={a} worker={worker} onSeek={a.url ? onSeek : undefined} onChange={onTranscript} currentMs={t * 1000} playing={playing} />
    </figure>
  );
}

export function Attachments({
  attachments, uploads, worker, onChanged, onDismissUpload,
}: {
  attachments: Attachment[];
  uploads: Upload[];
  worker: WorkerStatus | undefined;
  /** Takes an update function: uploads finishing meanwhile change the list too, so it must not be replaced from a stale copy. */
  onChanged: Dispatch<SetStateAction<Attachment[]>>;
  onDismissUpload: (key: string) => void;
}) {
  const { confirm } = useConfirm();
  const notify = useToast();
  const remove = async (a: Attachment) => {
    const what = a.kind === 'frame' ? 'frame' : a.kind === 'image' ? 'photo' : a.kind;
    if (!(await confirm({ title: `Delete this ${what}?`, message: a.fileName, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.deleteAttachment(a.id);
      onChanged((list) => list.filter((x) => x.id !== a.id));
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };
  const setTranscript = (id: string, transcript: TranscriptState) =>
    onChanged((list) => list.map((x) => (x.id === id ? { ...x, transcript } : x)));
  const videos = attachments.filter((a) => a.kind === 'video');
  const audios = attachments.filter((a) => a.kind === 'audio');
  const videoIds = new Set(videos.map((v) => v.id));
  const loose = attachments.filter(
    (a) => a.kind !== 'video' && a.kind !== 'audio' && !(a.kind === 'frame' && a.sourceId && videoIds.has(a.sourceId)),
  );

  return (
    <div className="atts">
      {uploads.map((u) => (
        <div key={u.key} className="upload" data-error={!!u.error}>
          <Icon name={u.error ? 'alert' : 'paperclip'} />
          <div className="upload__text">
            <span className="t-truncate">{u.name}</span>
            <span className="t-subtle">{u.error ?? `${Math.round(u.progress * 100)} % of ${formatSize(u.size)}`}</span>
            {!u.error && <span className="upload__bar"><span style={{ width: `${u.progress * 100}%` }} /></span>}
          </div>
          <IconButton size="sm" icon="x" label={u.error ? 'Dismiss' : 'Cancel upload'} onClick={() => (u.error ? onDismissUpload(u.key) : u.abort())} />
        </div>
      ))}
      {videos.map((v) => (
        <VideoCard
          key={v.id}
          a={v}
          worker={worker}
          frames={attachments.filter((f) => f.kind === 'frame' && f.sourceId === v.id).sort((x, y) => (x.atMs ?? 0) - (y.atMs ?? 0))}
          onFrame={(f) => onChanged((list) => (list.some((x) => x.id === f.id) ? list : [...list, f]))}
          onTranscript={(t) => setTranscript(v.id, t)}
          onDelete={() => void remove(v)}
          onDeleteFrame={(f) => void remove(f)}
          onNote={(f) => onChanged((list) => list.map((x) => (x.id === f.id ? { ...x, note: f.note } : x)))}
        />
      ))}
      {audios.map((x) => (
        <AudioCard key={x.id} a={x} worker={worker} onTranscript={(t) => setTranscript(x.id, t)} onDelete={() => void remove(x)} />
      ))}
      {loose.length > 0 && (
        <div className="att-grid">
          {loose.map((a) => (
            <figure key={a.id} className="att">
              {a.url ? (
                <a href={a.url} target="_blank" rel="noopener noreferrer" className="att__thumb">
                  {a.mime === 'image/heic' ? <span className="att__gone"><Icon name="image" /> HEIC — open</span> : <img src={a.url} alt={a.fileName} loading="lazy" />}
                </a>
              ) : (
                <div className="att__gone"><Icon name="image" /> Deleted</div>
              )}
              <figcaption className="att__cap">
                {a.kind === 'frame' && <Badge tone="accent" icon="aperture">{clock(a.atMs ?? 0)}</Badge>}
                {a.createdBy !== 'human' && <Badge icon="bot">{a.createdBy}</Badge>}
                <span className="t-truncate t-subtle">{a.fileName}</span>
                {a.kind === 'frame' && a.note && <span className="att__note-text">{a.note}</span>}
                <span className="t-spacer" />
                <IconButton size="sm" icon="trash" label="Delete" onClick={() => void remove(a)} />
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

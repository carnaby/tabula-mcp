import { useEffect, useRef, useState } from 'react';
import { Button, useToast } from '../../ui';

export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};

/** The first type this browser can record: Chrome/Firefox WebM, Safari MP4. */
function pickType(candidates: string[]): string {
  return candidates.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) ?? '';
}

type Mode = 'voice' | 'screen';

/**
 * Record a voice note (microphone) or, on desktops, the screen with the microphone — "show and tell" instead of
 * typing. On phones a screen recording is made with the system recorder and added from the gallery.
 */
export function Recorder({ mode, onDone, onCancel }: { mode: Mode; onDone: (file: File) => void; onCancel: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const streams = useRef<MediaStream[]>([]);
  const chunks = useRef<Blob[]>([]);
  const notify = useToast();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stopAll = () => streams.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    (async () => {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        streams.current.push(mic);
        // Closed while the browser was asking for permission: the cleanup already ran, so stop what came late.
        if (cancelled) return stopAll();
        let stream = mic;
        if (mode === 'screen') {
          const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
          streams.current.push(screen);
          if (cancelled) return stopAll();
          stream = new MediaStream([...screen.getVideoTracks(), ...mic.getAudioTracks()]);
          // Stopping the share from the browser's bar ends the recording too.
          screen.getVideoTracks()[0]?.addEventListener('ended', () => rec.current?.state === 'recording' && rec.current.stop());
        }
        const type =
          mode === 'voice'
            ? pickType(['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'])
            : pickType(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/mp4']);
        const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
        r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
        r.onstop = () => {
          stopAll();
          if (cancelled || chunks.current.length === 0) return;
          const mime = r.mimeType || type || (mode === 'voice' ? 'audio/webm' : 'video/webm');
          const ext = mime.includes('mp4') ? (mode === 'voice' ? 'm4a' : 'mp4') : mime.includes('ogg') ? 'ogg' : 'webm';
          const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
          onDone(new File(chunks.current, `${mode === 'voice' ? 'voice' : 'screen'}-${stamp}.${ext}`, { type: mime.split(';')[0] }));
        };
        r.start(1000);
        rec.current = r;
        const start = Date.now();
        timer = setInterval(() => setElapsed(Date.now() - start), 250);
      } catch (e) {
        stopAll();
        if (cancelled) return;
        const msg = (e as Error).name === 'NotAllowedError' ? 'Permission denied — allow the microphone (and screen) for Tabula.' : (e as Error).message;
        setError(msg);
        notify(msg, { tone: 'danger' });
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (rec.current?.state === 'recording') rec.current.stop();
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return (
    <div className="recorder" role="status">
      <span className="recorder__dot" data-on={!error && !!rec.current} />
      <span className="recorder__label">{error ? 'Not recording' : mode === 'voice' ? 'Recording voice' : 'Recording screen + voice'}</span>
      <span className="recorder__time">{clock(elapsed)}</span>
      <span className="t-spacer" />
      <Button size="sm" onClick={onCancel}>Cancel</Button>
      <Button size="sm" variant="danger-solid" icon="stop" disabled={!!error} onClick={() => rec.current?.stop()}>Stop</Button>
    </div>
  );
}

export const canRecordVoice = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
export const canRecordScreen = () =>
  canRecordVoice() && !!navigator.mediaDevices?.getDisplayMedia && !window.matchMedia('(pointer: coarse)').matches;

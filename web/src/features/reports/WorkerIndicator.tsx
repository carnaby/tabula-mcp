import { timeAgo } from '../../format';
import type { WorkerStatus } from '../../types';
import { cx, Popover } from '../../ui';
import { workerAlive } from './Transcript';

export type WorkerTone = 'idle' | 'busy' | 'waiting' | 'offline';

/** What a glance at the header should tell: the dot's colour and a few words. */
export function workerSummary(s: WorkerStatus, now = Date.now()): { tone: WorkerTone; label: string } {
  if (workerAlive(s, now)) {
    if (s.running > 0) return { tone: 'busy', label: s.queued > 0 ? `Transcribing · ${s.queued} waiting` : 'Transcribing' };
    return { tone: 'idle', label: 'Worker' };
  }
  // A job "running" on a worker that stopped answering goes back to the queue when its lease runs out.
  const waiting = s.queued + s.running;
  return waiting > 0 ? { tone: 'waiting', label: `Worker offline · ${waiting} waiting` } : { tone: 'offline', label: 'Worker offline' };
}

/**
 * The transcription worker in the header: a dot with a few words; a click shows when it last called in, what waits,
 * runs and failed, and how to start it. Nothing when the server has no worker (no TABULA_WORKER_TOKEN).
 */
export function WorkerIndicator({ status, align = 'start', className }: { status: WorkerStatus | undefined; align?: 'start' | 'end'; className?: string }) {
  if (!status || !status.enabled) return null;
  const { tone, label } = workerSummary(status);
  const alive = tone === 'idle' || tone === 'busy';
  const last = status.workers[0];
  return (
    <Popover
      fixed
      align={align}
      className={cx('worker-ind', className)}
      triggerClassName="worker-ind__trigger"
      triggerLabel={`${label}. Transcription worker details`}
      triggerTitle={label}
      trigger={
        <>
          <span className="worker-ind__dot" data-tone={tone} aria-hidden="true" />
          <span className="worker-ind__label">{label}</span>
        </>
      }
    >
      {(_close, labelId) => (
        <div className="worker-ind__panel">
          <p id={labelId} className="worker-ind__title">Transcription worker</p>
          <p>
            {last ? (
              <>Last seen {timeAgo(last.lastSeenAt)} · {last.name}{last.version ? ` ${last.version}` : ''}</>
            ) : (
              'It has never connected.'
            )}
          </p>
          <dl className="worker-ind__counts">
            <div><dt>Waiting</dt><dd>{status.queued}</dd></div>
            <div><dt>Running</dt><dd>{status.running}</dd></div>
            <div><dt>Failed</dt><dd>{status.failed}</dd></div>
          </dl>
          {!alive && (
            <p className="worker-ind__hint">Start the Tabula tray or run <code>tabula worker --once</code> on your PC.</p>
          )}
        </div>
      )}
    </Popover>
  );
}

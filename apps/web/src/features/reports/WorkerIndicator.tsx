import type { WorkerStatus } from '../../types';
import { cx, Popover } from '../../ui';

export type WorkerTone = 'idle' | 'busy' | 'waiting' | 'offline';

/** What a glance at the header should tell: the dot's colour and a few words. */
export function workerSummary(s: WorkerStatus): { tone: WorkerTone; label: string } {
  if (s.online === null) return { tone: 'offline', label: 'Fornax unreachable' };
  if (s.online) {
    if (s.running > 0) return { tone: 'busy', label: s.queued > 0 ? `Working · ${s.queued} waiting` : 'Working' };
    return { tone: 'idle', label: 'Worker' };
  }
  const waiting = s.queued + s.running;
  return waiting > 0 ? { tone: 'waiting', label: `Worker offline · ${waiting} waiting` } : { tone: 'offline', label: 'Worker offline' };
}

const STATE_TEXT = {
  unreachable: 'Fornax cannot be reached right now, so the worker\'s state is unknown. Files wait and are tried again.',
  online: 'The Fornax worker is online.',
  offline: 'The Fornax worker is offline. Files wait until it is back.',
};

/**
 * The Fornax worker in the header: a dot with a few words; a click shows whether it is online, what waits, runs and
 * failed, and links to Fornax. Nothing when the server has no Fornax (no TABULA_FORNAX_URL).
 */
export function WorkerIndicator({ status, align = 'start', className }: { status: WorkerStatus | undefined; align?: 'start' | 'end'; className?: string }) {
  if (!status || !status.enabled) return null;
  const { tone, label } = workerSummary(status);
  const state = status.online === null ? STATE_TEXT.unreachable : status.online ? STATE_TEXT.online : STATE_TEXT.offline;
  return (
    <Popover
      fixed
      align={align}
      className={cx('worker-ind', className)}
      triggerClassName="worker-ind__trigger"
      triggerLabel={`${label}. Fornax worker details`}
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
          <p id={labelId} className="worker-ind__title">Fornax worker</p>
          <p>{state}{status.online !== null && status.offered === false && ' It does not offer transcription.'}</p>
          <dl className="worker-ind__counts">
            <div><dt>Waiting</dt><dd>{status.queued}</dd></div>
            <div><dt>Running</dt><dd>{status.running}</dd></div>
            <div><dt>Failed</dt><dd>{status.failed}</dd></div>
          </dl>
          {status.url && <p className="worker-ind__hint"><a href={status.url} target="_blank" rel="noreferrer">Open Fornax</a></p>}
        </div>
      )}
    </Popover>
  );
}

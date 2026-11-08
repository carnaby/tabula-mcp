import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { SpeakerName, TranscriptState } from '../../types';
import { Button, cx, Icon, Input, Popover, useToast } from '../../ui';

/** A speaker's colour slot, 1–6, stable by number: S1 → 1 … S6 → 6, S7 → 1 again. */
export const speakerSlot = (id: string): number => ((Math.max(1, Number(id.slice(1)) || 1) - 1) % 6) + 1;

/** The server's limit on a name, in code points (not UTF-16 units). */
const MAX_NAME = 60;

/** Name suggestions per report, fetched once per page; a saved name drops the report's entry. */
const suggestions = new Map<string, Promise<string[]>>();
function suggestionsFor(reportId: string): Promise<string[]> {
  let p = suggestions.get(reportId);
  if (!p) {
    p = api.speakerNames(reportId).then((r) => r.names);
    p.catch(() => suggestions.delete(reportId));
    suggestions.set(reportId, p);
  }
  return p;
}

type ChipProps = {
  id: string;
  entry: SpeakerName | undefined;
  attachmentId: string;
  reportId: string;
  onSaved: (t: TranscriptState) => void;
  /** A re-run is queued or running: the names will be cleared, so the chip is a plain label. */
  locked?: boolean;
};

/** The coloured label before a speaker's lines: the name or "S1"; a click opens the naming popover. */
export function SpeakerChip({ id, entry, attachmentId, reportId, onSaved, locked }: ChipProps) {
  const label = entry?.name ?? id;
  const byClaude = entry?.by === 'agent';
  if (locked) {
    return (
      <span className={cx('speaker__chip', 'speaker__chip--static', `speaker__chip--${speakerSlot(id)}`, byClaude && 'speaker__chip--agent')} title="Names are cleared when the new transcript is in">
        <span className="t-truncate">{label}</span>
        {byClaude && <Icon name="claude" />}
      </span>
    );
  }
  return (
    <Popover
      className="speaker"
      fixed
      triggerClassName={cx('speaker__chip', `speaker__chip--${speakerSlot(id)}`, byClaude && 'speaker__chip--agent')}
      triggerLabel={`${label}${entry ? ` (${id})` : ''}${byClaude ? ', suggested by Claude' : ''}. Name this speaker`}
      triggerTitle={byClaude ? 'Suggested by Claude' : undefined}
      trigger={
        <>
          <span className="t-truncate">{label}</span>
          {byClaude && <Icon name="claude" />}
        </>
      }
    >
      {(close, labelId) => (
        <SpeakerForm id={id} entry={entry} attachmentId={attachmentId} reportId={reportId} labelId={labelId} close={close} onSaved={onSaved} />
      )}
    </Popover>
  );
}

function SpeakerForm({ id, entry, attachmentId, reportId, labelId, close, onSaved }: ChipProps & { labelId: string; close: () => void }) {
  const notify = useToast();
  const [draft, setDraft] = useState(entry?.name ?? '');
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    let live = true;
    suggestionsFor(reportId).then((n) => live && setNames(n)).catch(() => {});
    return () => { live = false; };
  }, [reportId]);
  const save = async (name: string) => {
    setBusy(true);
    try {
      onSaved(await api.setSpeakers(attachmentId, { [id]: name }));
      suggestions.delete(reportId);
      close();
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const q = draft.trim().toLocaleLowerCase();
  const shown = names.filter((n) => n.toLocaleLowerCase() !== q && n.toLocaleLowerCase().includes(q)).slice(0, 8);
  const clearing = !draft.trim() && !!entry;
  const tooLong = [...draft.trim()].length > MAX_NAME;
  return (
    <form className="speaker__form" onSubmit={(e) => { e.preventDefault(); if (!tooLong && (draft.trim() || entry)) void save(draft.trim()); }}>
      <label id={labelId} className="speaker__title" htmlFor={`${labelId}-name`}>Who is {id}?</label>
      {entry?.by === 'agent' && (
        <p className="speaker__hint"><Icon name="claude" /> Suggested by Claude. Save it, or change it, to confirm.</p>
      )}
      <Input
        id={`${labelId}-name`} ref={input} size_="sm" value={draft} placeholder="Name"
        aria-invalid={tooLong || undefined} onChange={(e) => setDraft(e.target.value)}
      />
      {tooLong && <p className="speaker__hint" role="alert">At most {MAX_NAME} characters.</p>}
      {shown.length > 0 && (
        <div className="speaker__suggestions" role="group" aria-label="Names used before">
          {shown.map((n) => (
            <button key={n} type="button" className="t-popover__item" disabled={busy} onClick={() => void save(n)}>{n}</button>
          ))}
        </div>
      )}
      <div className="speaker__actions">
        <Button size="sm" type="submit" variant={clearing ? 'default' : 'primary'} loading={busy} disabled={tooLong || (!draft.trim() && !entry)}>{clearing ? 'Clear the name' : 'Save'}</Button>
      </div>
    </form>
  );
}

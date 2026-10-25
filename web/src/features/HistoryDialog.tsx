import { useState } from 'react';
import { api } from '../api';
import { useQuery } from '../hooks/data';
import { fullDate } from '../format';
import type { Thought, ThoughtRevision } from '../types';
import { Alert, Button, Dialog, EmptyState, Markdown, Skeleton } from '../ui';
import { Author, TimeAgo } from './common';

export function HistoryDialog({
  thought, open, onClose, onRestore,
}: { thought: Thought; open: boolean; onClose: () => void; onRestore: (r: ThoughtRevision) => void }) {
  const revs = useQuery((s) => api.revisions(thought.id, s), [thought.id, thought.version], { enabled: open, refetchOnFocus: false });
  const [selected, setSelected] = useState<ThoughtRevision | null>(null);
  const current = selected && revs.data?.find((r) => r.id === selected.id);

  return (
    <Dialog
      open={open}
      onClose={() => { setSelected(null); onClose(); }}
      title="Version history"
      size="lg"
      footer={
        <>
          <Button onClick={() => { setSelected(null); onClose(); }}>Close</Button>
          <Button variant="primary" icon="undo" disabled={!current} onClick={() => { onRestore(current!); setSelected(null); }}>
            Restore this version
          </Button>
        </>
      }
    >
      <Alert icon="history">
        Every change to the text — yours or an agent's — keeps the previous version (the last 50). Restoring is itself a change, so it can be undone too.
      </Alert>
      <div className="revision-list">
        <div className="revision" style={{ cursor: 'default' }}>
          <div className="revision__text">
            <strong>v{thought.version} · current</strong>
            <span className="t-subtle"><TimeAgo iso={thought.updatedAt} /></span>
          </div>
          <Author source={thought.editedBy === 'human' ? 'human' : 'agent'} label={thought.editedBy} />
        </div>
        {!revs.data && <Skeleton height={44} />}
        {revs.data?.length === 0 && <EmptyState icon="history" title="No earlier versions">The text hasn't been changed since it was written.</EmptyState>}
        {revs.data?.map((r) => (
          <button key={r.id} type="button" className="revision" aria-pressed={selected?.id === r.id} onClick={() => setSelected(r)}>
            <div className="revision__text">
              <strong className="t-truncate">v{r.version} · {r.title}</strong>
              <span className="t-subtle" title={fullDate(r.createdAt)}><TimeAgo iso={r.createdAt} /></span>
            </div>
            <Author source={r.editedBy === 'human' ? 'human' : 'agent'} label={r.editedBy} />
          </button>
        ))}
      </div>
      {current && (
        <div className="t-card t-card--pad">
          <h3 style={{ marginBottom: 10 }}>{current.title}</h3>
          {current.body.trim() ? <Markdown source={current.body} /> : <p className="t-subtle">Empty body.</p>}
        </div>
      )}
    </Dialog>
  );
}

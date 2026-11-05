import { useEffect, useRef, useState } from 'react';
import { refQuery } from '../../../src/shared/refs';
import { api, ApiError } from '../api';
import { Highlighted, KindBadge, TimeAgo } from '../features/common';
import { MemoryDialog, type MemoryDialogState } from '../features/MemoryDialog';
import { PageHeader } from '../features/PageHeader';
import { refHref } from '../features/refs';
import { useDebounced, useQuery } from '../hooks/data';
import { href, navigate } from '../router';
import type { Project, RecordType, RefCandidate, SearchHit } from '../types';
import { Alert, Badge, EmptyState, Icon, type IconName, SearchInput, Skeleton, useToast } from '../ui';

const TYPE: Record<RecordType, { icon: IconName; label: string }> = {
  report: { icon: 'bug', label: 'Bug report' },
  memory: { icon: 'layers', label: 'Memory' },
  note: { icon: 'pencil', label: 'Note' },
  thought: { icon: 'lightbulb', label: 'Thought' },
  file: { icon: 'fileText', label: 'File' },
  attachment: { icon: 'paperclip', label: 'Attachment' },
};

/** A pasted reference that leads nowhere: no record has it, or several do (pick one by its longer reference). */
function RefError({ value, error, onPick }: { value: string; error: Error; onPick: (ref: string) => void }) {
  if (error instanceof ApiError && error.status === 404) {
    return <EmptyState icon="search" title={`No record ${value}`}>Check the reference, or search for words instead.</EmptyState>;
  }
  const candidates = error instanceof ApiError && Array.isArray(error.data.candidates) ? (error.data.candidates as RefCandidate[]) : null;
  if (!candidates) return <Alert tone="danger">{error.message}</Alert>;
  return (
    <div className="t-stack">
      <p className="t-muted">{value} matches {candidates.length} records. Pick one:</p>
      <div className="hits">
        {candidates.map((c) => (
          <button key={c.id} type="button" className="t-card t-card--interactive hit" onClick={() => onPick(c.ref)}>
            <span className="hit__icon"><Icon name={TYPE[c.type].icon} /></span>
            <span className="hit__body">
              <span className="hit__title">{c.title}</span>
              <span className="t-row" style={{ gap: 6 }}>
                <Badge tone="outline">{TYPE[c.type].label}</Badge>
                <span className="t-mono t-subtle" style={{ fontSize: 12 }}>{c.ref}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function SearchPage({ q: initialQ, projects }: { q: string; projects: Project[] | undefined }) {
  const [q, setQ] = useState(initialQ);
  const dq = useDebounced(q.trim(), 200);
  // A query that is one whole reference (tabula:d86d86e7) opens its record instead of listing hits.
  const asRef = refQuery(dq);
  const input = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<MemoryDialogState>(null);
  const notify = useToast();
  const hits = useQuery((s) => (dq && !asRef ? api.search(dq, s) : Promise.resolve([])), [dq], { topics: ['memories', 'notes', 'thoughts', 'files'] });
  // Why the last reference led nowhere, kept with that reference: while the next one resolves, its error is not shown.
  const [refError, setRefError] = useState<{ ref: string; error: Error } | null>(null);

  useEffect(() => input.current?.focus(), []);
  // Keep the query in the address so back/forward and reload work, without adding history entries.
  useEffect(() => {
    history.replaceState(null, '', href.search(dq));
  }, [dq]);
  useEffect(() => {
    if (!asRef) return;
    const ac = new AbortController();
    api.resolve(asRef, ac.signal).then(
      // replace(): Back then leads to the page before the search, not to a search that would only redirect again.
      (t) => !ac.signal.aborted && window.location.replace(refHref(t)),
      (error: Error) => !ac.signal.aborted && error.name !== 'AbortError' && setRefError({ ref: asRef, error }),
    );
    return () => ac.abort();
  }, [asRef]);

  const open = async (h: SearchHit) => {
    // The editor's back button returns to this search with its query.
    const from = href.search(dq);
    if (h.type === 'file') return navigate(href.file(h.project!, h.title, from));
    if (h.type === 'thought') return navigate(href.thought(h.id, from));
    if (h.type === 'report') return navigate(href.report(h.id, undefined, from));
    if (h.type === 'note') return navigate(href.note(h.id, from));
    try {
      setDialog({ mode: 'edit', memory: await api.memory(h.id) });
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  return (
    <main className="content content--wide">
      <PageHeader
        title="Search"
        description="Rules, files, reports, notes and thoughts."
        more="Global rules, project files, bug reports, notes and thoughts at once. Words match as prefixes: “drizz pri” finds “Drizzle over Prisma”. Paste a reference (tabula:d86d86e7) to open its record."
      />
      <div className="search-hero">
        <SearchInput ref={input} value={q} onChange={setQ} placeholder="Search everything" />
      </div>
      {asRef ? (
        refError?.ref === asRef ? <RefError value={asRef} error={refError.error} onPick={setQ} /> : <Skeleton height={72} />
      ) : (
        <>
          {hits.error && <Alert tone="danger">{hits.error.message}</Alert>}
          {dq && !hits.data && <Skeleton height={72} />}
          {!dq && <EmptyState icon="search" title="Type to search">Tip: press Ctrl K (⌘K on Mac) anywhere to come here.</EmptyState>}
          {dq && hits.data?.length === 0 && <EmptyState icon="search" title={`Nothing found for “${dq}”`}>Try fewer or shorter words.</EmptyState>}
          {dq && hits.data && hits.data.length > 0 && (
            <div className="hits" style={{ opacity: hits.loading ? 0.6 : 1 }}>
              {hits.data.map((h) => (
                <button key={`${h.type}-${h.id}`} type="button" className="t-card t-card--interactive hit" onClick={() => void open(h)}>
                  <span className="hit__icon"><Icon name={TYPE[h.type].icon} /></span>
                  <span className="hit__body">
                    <span className="hit__title" style={h.status === 'deprecated' ? { textDecoration: 'line-through', color: 'var(--text-subtle)' } : undefined}>{h.title}</span>
                    {h.snippet && <span className="hit__snippet"><Highlighted text={h.snippet} /></span>}
                    <span className="t-row" style={{ gap: 6 }}>
                      <Badge tone="outline">{TYPE[h.type].label}</Badge>
                      {h.kind && <KindBadge kind={h.kind} />}
                      {h.project && <Badge>{h.project}</Badge>}
                      {h.status === 'deprecated' && <Badge>deprecated</Badge>}
                      <span className="t-subtle" style={{ fontSize: 12 }}><TimeAgo iso={h.updated_at} /></span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <MemoryDialog state={dialog} projects={projects} onClose={() => setDialog(null)} />
    </main>
  );
}

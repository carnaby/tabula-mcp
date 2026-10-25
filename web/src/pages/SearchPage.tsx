import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Highlighted, KindBadge, TimeAgo } from '../features/common';
import { MemoryDialog, type MemoryDialogState } from '../features/MemoryDialog';
import { useDebounced, useQuery } from '../hooks/data';
import { href, navigate } from '../router';
import type { Project, SearchHit } from '../types';
import { Alert, Badge, EmptyState, Icon, type IconName, SearchInput, Skeleton, useToast } from '../ui';

const TYPE: Record<SearchHit['type'], { icon: IconName; label: string }> = {
  memory: { icon: 'layers', label: 'Memory' },
  note: { icon: 'fileText', label: 'Note' },
  thought: { icon: 'lightbulb', label: 'Thought' },
};

export function SearchPage({ q: initialQ, projects }: { q: string; projects: Project[] | undefined }) {
  const [q, setQ] = useState(initialQ);
  const dq = useDebounced(q.trim(), 200);
  const input = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<MemoryDialogState>(null);
  const notify = useToast();
  const hits = useQuery((s) => (dq ? api.search(dq, s) : Promise.resolve([])), [dq], { topics: ['memories', 'notes', 'thoughts'] });

  useEffect(() => input.current?.focus(), []);
  // Keep the query in the address so back/forward and reload work, without adding history entries.
  useEffect(() => {
    history.replaceState(null, '', href.search(dq));
  }, [dq]);

  const open = async (h: SearchHit) => {
    if (h.type === 'thought') return navigate(href.thought(h.id));
    if (h.type === 'note') return navigate(href.note(h.project!, h.id));
    try {
      setDialog({ mode: 'edit', memory: await api.memory(h.id) });
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  return (
    <main className="content">
      <div className="page-head">
        <div className="page-head__text">
          <h1>Search</h1>
          <p>Memories, notes and thoughts at once. Words match as prefixes: “drizz pri” finds “Drizzle over Prisma”.</p>
        </div>
      </div>
      <div className="search-hero">
        <SearchInput ref={input} value={q} onChange={setQ} placeholder="Search everything" />
      </div>
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
      <MemoryDialog state={dialog} projects={projects} onClose={() => setDialog(null)} />
    </main>
  );
}

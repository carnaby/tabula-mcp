import { useState } from 'react';
import { api } from '../api';
import { useClampPage, useDebounced, useQuery, useTableState } from '../hooks/data';
import { excerpt } from '../format';
import { KIND_INFO, KINDS, type Memory, type MemoryKind, type MemorySort, type Project, type Source } from '../types';
import { Alert, Badge, Button, type Column, DataTable, EmptyState, PAGE_SIZES, Pagination, SearchInput, Segmented, Select } from '../ui';
import { Author, KindBadge, ProjectSelect, TimeAgo } from './common';
import { FilterToggle } from './FilterToggle';
import { MemoryDialog, type MemoryDialogState } from './MemoryDialog';

type Filters = { q: string; kind: MemoryKind | ''; status: 'active' | 'deprecated' | 'all'; source: Source | ''; project: string };

export function MemoriesTable({ project, projects }: { project?: string; projects: Project[] | undefined }) {
  const t = useTableState<MemorySort, Filters>(project ? 'project-memories' : 'memories', {
    sort: 'createdAt', dir: 'desc', filters: { q: '', kind: '', status: 'active', source: '', project: '' },
  });
  const [dialog, setDialog] = useState<MemoryDialogState>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const q = useDebounced(t.filters.q);
  const scope = project ?? t.filters.project;
  const query = useQuery(
    (signal) =>
      api.memories(
        { project: scope || undefined, kind: t.filters.kind, status: t.filters.status, source: t.filters.source, q, page: t.page, pageSize: t.pageSize, sort: t.sort, dir: t.dir },
        signal,
      ),
    [scope, t.filters.kind, t.filters.status, t.filters.source, q, t.page, t.pageSize, t.sort, t.dir],
    { topics: ['memories'] },
  );
  useClampPage(query.data?.total, t.page, t.pageSize, t.setPage);

  const columns: Column<Memory, MemorySort>[] = [
    {
      id: 'title',
      header: 'Memory',
      sort: 'title',
      primary: true,
      cell: (m) => (
        <div style={{ minWidth: 0 }}>
          <div className="t-table__primary">{m.title}</div>
          <div className="t-table__secondary t-table__clip">{excerpt(m.body, 140)}</div>
        </div>
      ),
    },
    { id: 'kind', header: 'Kind', sort: 'kind', width: 100, cell: (m) => <KindBadge kind={m.kind} /> },
    ...(project ? [] : [{ id: 'project', header: 'Project', sort: 'projectId' as const, width: 140, cell: (m: Memory) => <span className="t-mono t-muted">{m.projectId}</span> }]),
    { id: 'source', header: 'Author', sort: 'source', width: 150, cell: (m) => <Author source={m.source} label={m.agentLabel} /> },
    ...(t.filters.status === 'active' ? [] : [{
      id: 'status', header: 'Status', sort: 'status' as const, width: 110,
      cell: (m: Memory) => <Badge tone={m.status === 'active' ? 'success' : 'neutral'}>{m.status}</Badge>,
    }]),
    { id: 'created', header: 'Created', sort: 'createdAt', firstDir: 'desc', width: 130, align: 'right', cell: (m) => <span className="t-subtle"><TimeAgo iso={m.createdAt} /></span> },
  ];

  const filtered = !!(t.filters.q || t.filters.kind || t.filters.source || t.filters.status !== 'active' || t.filters.project);

  return (
    <div className="t-stack">
      <div className="toolbar">
        <SearchInput value={t.filters.q} onChange={(v) => t.setFilter('q', v)} placeholder="Search title, tags, body" />
        <FilterToggle
          open={filtersOpen}
          onToggle={() => setFiltersOpen(!filtersOpen)}
          active={[t.filters.kind, t.filters.source, t.filters.project, t.filters.status !== 'active'].filter(Boolean).length}
        />
        <div className="toolbar__filters" data-open={filtersOpen}>
        {!project && <ProjectSelect projects={projects} value={t.filters.project} onChange={(v) => t.setFilter('project', v)} allowAll />}
        <Select
          aria-label="Kind"
          value={t.filters.kind}
          onChange={(v) => t.setFilter('kind', v)}
          options={[{ value: '' as const, label: 'All kinds' }, ...KINDS.map((k) => ({ value: k, label: KIND_INFO[k].label }))]}
        />
        <Select
          aria-label="Author"
          value={t.filters.source}
          onChange={(v) => t.setFilter('source', v)}
          options={[{ value: '' as const, label: 'Anyone' }, { value: 'agent' as const, label: 'Agents' }, { value: 'human' as const, label: 'You' }]}
        />
        <Segmented
          label="Status"
          value={t.filters.status}
          onChange={(v) => t.setFilter('status', v)}
          options={[{ value: 'active', label: 'Active' }, { value: 'deprecated', label: 'Deprecated' }, { value: 'all', label: 'All' }]}
        />
        </div>
        <span className="t-spacer" />
        <Button variant="primary" icon="plus" onClick={() => setDialog({ mode: 'create', projectId: scope || 'global' })}>New memory</Button>
      </div>

      {query.error && <Alert tone="danger">{query.error.message}</Alert>}

      <DataTable
        label="Memories"
        columns={columns}
        rows={query.data?.items}
        rowKey={(m) => m.id}
        loading={query.loading}
        rowMuted={(m) => m.status === 'deprecated'}
        onRowClick={(m) => setDialog({ mode: 'edit', memory: m })}
        sort={{ sort: t.sort, dir: t.dir }}
        onSort={t.setSort}
        empty={
          filtered ? (
            <EmptyState icon="search" title="No memories match" action={<Button onClick={t.resetFilters}>Clear filters</Button>}>
              Try fewer words or another filter.
            </EmptyState>
          ) : (
            <EmptyState icon="layers" title="No memories yet" action={<Button variant="primary" icon="plus" onClick={() => setDialog({ mode: 'create', projectId: scope || 'global' })}>Add the first one</Button>}>
              Agents write rules, gotchas, decisions and facts here at the end of a session. You can add your own too.
            </EmptyState>
          )
        }
        footer={query.data && query.data.total > PAGE_SIZES[0] && <Pagination page={t.page} pageSize={t.pageSize} total={query.data.total} onPage={t.setPage} onPageSize={t.setPageSize} />}
      />

      <MemoryDialog state={dialog} projects={projects} onClose={() => setDialog(null)} />
    </div>
  );
}

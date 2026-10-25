import { api } from '../api';
import { useClampPage, useDebounced, useQuery, useTableState } from '../hooks/data';
import { href, navigate } from '../router';
import type { Note, NoteSort } from '../types';
import { Alert, Badge, Button, ButtonLink, type Column, DataTable, EmptyState, PAGE_SIZES, Pagination, SearchInput } from '../ui';
import { TimeAgo } from './common';

export function NotesTable({ project }: { project: string }) {
  const t = useTableState<NoteSort, { q: string }>('notes', { sort: 'pinned', dir: 'desc', filters: { q: '' } });
  const q = useDebounced(t.filters.q);
  const query = useQuery(
    (signal) => api.notes({ project, q, page: t.page, pageSize: t.pageSize, sort: t.sort, dir: t.dir }, signal),
    [project, q, t.page, t.pageSize, t.sort, t.dir],
    { topics: ['notes'] },
  );
  useClampPage(query.data?.total, t.page, t.pageSize, t.setPage);

  const columns: Column<Note, NoteSort>[] = [
    {
      id: 'title', header: 'Note', sort: 'title', primary: true,
      cell: (n) => (
        <div style={{ minWidth: 0 }}>
          <div className="t-table__primary">{n.title}</div>
          {n.summary && <div className="t-table__secondary">{n.summary}</div>}
        </div>
      ),
    },
    { id: 'pinned', header: 'Pinned', sort: 'pinned', firstDir: 'desc', width: 100, cell: (n) => n.pinned && <Badge tone="accent" icon="pin">pinned</Badge> },
    { id: 'size', header: 'Size', width: 150, align: 'right', cell: (n) => <span className="t-subtle t-nowrap">{n.wordCount} words · ~{n.tokenEstimate} tok</span> },
    { id: 'updated', header: 'Updated', sort: 'updatedAt', firstDir: 'desc', width: 130, align: 'right', cell: (n) => <span className="t-subtle"><TimeAgo iso={n.updatedAt} /></span> },
  ];

  return (
    <div className="t-stack">
      <div className="toolbar">
        <SearchInput value={t.filters.q} onChange={(v) => t.setFilter('q', v)} placeholder="Search notes" />
        <span className="t-spacer" />
        <ButtonLink href={href.note(project, 'new')} variant="primary" icon="plus">New note</ButtonLink>
      </div>
      <Alert>
        Notes are long, human-written context for agents (read-only for them). The digest lists each note's title and summary;
        a <strong>pinned</strong> note goes into every recall in full, so keep pinned notes short.
      </Alert>
      {query.error && <Alert tone="danger">{query.error.message}</Alert>}
      <DataTable
        label="Notes"
        columns={columns}
        rows={query.data?.items}
        rowKey={(n) => n.id}
        loading={query.loading}
        onRowClick={(n) => navigate(href.note(project, n.id))}
        sort={{ sort: t.sort, dir: t.dir }}
        onSort={t.setSort}
        empty={
          t.filters.q ? (
            <EmptyState icon="search" title="No notes match" action={<Button onClick={t.resetFilters}>Clear search</Button>} />
          ) : (
            <EmptyState icon="fileText" title="No notes in this project" action={<ButtonLink href={href.note(project, 'new')} variant="primary" icon="plus">Write a note</ButtonLink>}>
              Architecture overviews, conventions, protocols — anything longer than a memory.
            </EmptyState>
          )
        }
        footer={query.data && query.data.total > PAGE_SIZES[0] && <Pagination page={t.page} pageSize={t.pageSize} total={query.data.total} onPage={t.setPage} onPageSize={t.setPageSize} />}
      />
    </div>
  );
}

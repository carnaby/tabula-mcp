import { useState } from 'react';
import { api } from '../api';
import { TimeAgo } from '../features/common';
import { FilterToggle } from '../features/FilterToggle';
import { useClampPage, useDebounced, useQuery, useTableState } from '../hooks/data';
import { excerpt } from '../format';
import { href } from '../router';
import type { NoteSort } from '../types';
import { Alert, Badge, Button, ButtonLink, Chip, EmptyState, Icon, Pagination, SearchInput, Select, Skeleton } from '../ui';

type Filters = { q: string; tag: string };
const SORTS: { value: `${NoteSort}:${'asc' | 'desc'}`; label: string }[] = [
  { value: 'updatedAt:desc', label: 'Recently edited' },
  { value: 'createdAt:desc', label: 'Newest first' },
  { value: 'createdAt:asc', label: 'Oldest first' },
  { value: 'title:asc', label: 'Title A–Z' },
];

export function NotesPage() {
  const t = useTableState<NoteSort, Filters>('notebook', {
    sort: 'updatedAt', dir: 'desc', pageSize: 24, filters: { q: '', tag: '' },
  });
  const q = useDebounced(t.filters.q);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // "Recently edited" keeps pinned notes on top (the server default when no sort is given).
  const defaultSort = t.sort === 'updatedAt' && t.dir === 'desc';
  const list = useQuery(
    (s) => api.notes({ q, tag: t.filters.tag, page: t.page, pageSize: t.pageSize, ...(defaultSort ? {} : { sort: t.sort, dir: t.dir }) }, s),
    [q, t.filters.tag, t.page, t.pageSize, t.sort, t.dir],
    { topics: ['notes'] },
  );
  const tags = useQuery((s) => api.noteTags(s), [], { topics: ['notes'] });
  useClampPage(list.data?.total, t.page, t.pageSize, t.setPage);
  const filtered = !!(t.filters.q || t.filters.tag);

  return (
    <main className="content content--wide">
      <div className="page-head">
        <div className="page-head__text">
          <h1>Notes</h1>
          <p>Your own notes, outside projects. Agents read them only when you mention your notes, and they never go into recall. Pinned notes stay on top.</p>
        </div>
        <div className="page-head__actions">
          <ButtonLink href={href.note('new')} variant="primary" icon="plus">New note</ButtonLink>
        </div>
      </div>

      <div className="toolbar">
        <SearchInput value={t.filters.q} onChange={(v) => t.setFilter('q', v)} placeholder="Search notes" />
        <FilterToggle open={filtersOpen} onToggle={() => setFiltersOpen(!filtersOpen)} active={defaultSort ? 0 : 1} />
        <div className="toolbar__filters" data-open={filtersOpen}>
          <Select
            aria-label="Sort"
            value={`${t.sort}:${t.dir}` as (typeof SORTS)[number]['value']}
            onChange={(v) => {
              const [sort, dir] = v.split(':') as [NoteSort, 'asc' | 'desc'];
              t.setSort({ sort, dir });
            }}
            options={SORTS}
          />
        </div>
      </div>

      {(tags.data?.length ?? 0) > 0 && (
        <div className="t-chip-row" role="group" aria-label="Filter by tag">
          <Chip pressed={!t.filters.tag} onClick={() => t.setFilter('tag', '')}>All</Chip>
          {tags.data!.slice(0, 24).map((x) => (
            <Chip key={x.tag} pressed={t.filters.tag === x.tag} count={x.count} onClick={() => t.setFilter('tag', t.filters.tag === x.tag ? '' : x.tag)}>
              {x.tag}
            </Chip>
          ))}
        </div>
      )}

      {list.error && <Alert tone="danger">{list.error.message}</Alert>}

      {!list.data && (
        <div className="thought-grid">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={160} style={{ borderRadius: 12 }} />)}
        </div>
      )}

      {list.data?.items.length === 0 &&
        (filtered ? (
          <EmptyState icon="search" title="Nothing matches" action={<Button onClick={t.resetFilters}>Clear filters</Button>}>Try other words or another tag.</EmptyState>
        ) : (
          <EmptyState icon="fileText" title="No notes yet" action={<ButtonLink href={href.note('new')} variant="primary" icon="plus">Write the first note</ButtonLink>}>
            Anything you want to keep for yourself. An agent reads it only when you say “look in my notes”.
          </EmptyState>
        ))}

      {list.data && list.data.items.length > 0 && (
        <div className="thought-grid" style={{ opacity: list.loading ? 0.6 : 1, transition: 'opacity 160ms' }}>
          {list.data.items.map((n) => (
            <a key={n.id} href={href.note(n.id)} className="t-card t-card--interactive thought-card">
              <div className="thought-card__title">
                {n.pinned && <Icon name="pin" aria-label="Pinned" />}
                <span>{n.title}</span>
              </div>
              {n.body.trim() && <div className="thought-card__excerpt">{excerpt(n.body, 260)}</div>}
              {n.tags.length > 0 && (
                <div className="thought-card__tags">
                  {n.tags.slice(0, 5).map((tag) => <Badge key={tag}>{tag}</Badge>)}
                  {n.tags.length > 5 && <Badge tone="outline">+{n.tags.length - 5}</Badge>}
                </div>
              )}
              <div className="thought-card__meta">
                <TimeAgo iso={n.updatedAt} />
                {n.projectId && (
                  <>
                    <span>·</span>
                    <Badge tone="outline">{n.projectId}</Badge>
                  </>
                )}
              </div>
            </a>
          ))}
        </div>
      )}

      {list.data && list.data.total > 0 && (
        <div className="list-foot">
          <span>{list.data.total} {list.data.total === 1 ? 'note' : 'notes'}</span>
          {list.data.total > t.pageSize && (
            <Pagination page={t.page} pageSize={t.pageSize} total={list.data.total} onPage={(p) => { t.setPage(p); window.scrollTo(0, 0); }} />
          )}
        </div>
      )}
    </main>
  );
}

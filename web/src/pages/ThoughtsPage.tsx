import { useState } from 'react';
import { api } from '../api';
import { FilterToggle } from '../features/FilterToggle';
import { Author, TimeAgo } from '../features/common';
import { useClampPage, useDebounced, useQuery, useTableState } from '../hooks/data';
import { excerpt } from '../format';
import { href } from '../router';
import type { Source, ThoughtSort } from '../types';
import { Alert, Badge, Button, ButtonLink, Chip, EmptyState, Icon, Pagination, SearchInput, Segmented, Select, Skeleton } from '../ui';

type Filters = { q: string; tag: string; archived: 'false' | 'true'; source: Source | '' };
const SORTS: { value: `${ThoughtSort}:${'asc' | 'desc'}`; label: string }[] = [
  { value: 'updatedAt:desc', label: 'Recently edited' },
  { value: 'createdAt:desc', label: 'Newest first' },
  { value: 'createdAt:asc', label: 'Oldest first' },
  { value: 'title:asc', label: 'Title A–Z' },
];

export function ThoughtsPage() {
  const t = useTableState<ThoughtSort, Filters>('thoughts', {
    sort: 'updatedAt', dir: 'desc', pageSize: 24, filters: { q: '', tag: '', archived: 'false', source: '' },
  });
  const q = useDebounced(t.filters.q);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // "Recently edited" keeps pinned thoughts on top (server default when no sort is given).
  const serverSort = t.sort === 'updatedAt' && t.dir === 'desc' ? {} : { sort: t.sort, dir: t.dir };
  const list = useQuery(
    (s) => api.thoughts({ q, tag: t.filters.tag, archived: t.filters.archived, source: t.filters.source, page: t.page, pageSize: t.pageSize, ...serverSort }, s),
    [q, t.filters.tag, t.filters.archived, t.filters.source, t.page, t.pageSize, t.sort, t.dir],
    { topics: ['thoughts'] },
  );
  const tags = useQuery((s) => api.thoughtTags(s), [], { topics: ['thoughts'] });
  useClampPage(list.data?.total, t.page, t.pageSize, t.setPage);
  const filtered = !!(t.filters.q || t.filters.tag || t.filters.source || t.filters.archived === 'true');

  return (
    <main className="content content--wide">
      <div className="page-head">
        <div className="page-head__text">
          <h1>Thoughts</h1>
          <p>Your notebook — ideas, notes and things worth keeping. It belongs to no project and never goes into an agent’s recall. In a chat, ask Claude to “save this to Tabula” and it lands here.</p>
        </div>
        <div className="page-head__actions">
          <ButtonLink href={href.thought('new')} variant="primary" icon="plus">New thought</ButtonLink>
        </div>
      </div>

      <div className="toolbar">
        <SearchInput value={t.filters.q} onChange={(v) => t.setFilter('q', v)} placeholder="Search thoughts" />
        <FilterToggle
          open={filtersOpen}
          onToggle={() => setFiltersOpen(!filtersOpen)}
          active={[t.filters.source, t.filters.archived === 'true', !(t.sort === 'updatedAt' && t.dir === 'desc')].filter(Boolean).length}
        />
        <div className="toolbar__filters" data-open={filtersOpen}>
        <Select
          aria-label="Sort"
          value={`${t.sort}:${t.dir}` as (typeof SORTS)[number]['value']}
          onChange={(v) => {
            const [sort, dir] = v.split(':') as [ThoughtSort, 'asc' | 'desc'];
            t.setSort({ sort, dir });
          }}
          options={SORTS}
        />
        <Select
          aria-label="Author"
          value={t.filters.source}
          onChange={(v) => t.setFilter('source', v)}
          options={[{ value: '' as const, label: 'Anyone' }, { value: 'human' as const, label: 'Written by you' }, { value: 'agent' as const, label: 'Saved by AI' }]}
        />
        <Segmented
          label="Archive"
          value={t.filters.archived}
          onChange={(v) => t.setFilter('archived', v)}
          options={[{ value: 'false', label: 'Active' }, { value: 'true', label: 'Archived', icon: 'archive' }]}
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
          <EmptyState icon="lightbulb" title="Your notebook is empty" action={<ButtonLink href={href.thought('new')} variant="primary" icon="plus">Write the first thought</ButtonLink>}>
            Write something yourself, or tell Claude in any chat: “save this to Tabula”.
          </EmptyState>
        ))}

      {list.data && list.data.items.length > 0 && (
        <div className="thought-grid" style={{ opacity: list.loading ? 0.6 : 1, transition: 'opacity 160ms' }}>
          {list.data.items.map((th) => (
            <a key={th.id} href={href.thought(th.id)} className="t-card t-card--interactive thought-card">
              <div className="thought-card__title">
                {th.pinned && <Icon name="pin" aria-label="Pinned" />}
                <span>{th.title}</span>
              </div>
              {th.body.trim() && <div className="thought-card__excerpt">{excerpt(th.body, 260)}</div>}
              {th.tags.length > 0 && (
                <div className="thought-card__tags">
                  {th.tags.slice(0, 5).map((tag) => <Badge key={tag}>{tag}</Badge>)}
                  {th.tags.length > 5 && <Badge tone="outline">+{th.tags.length - 5}</Badge>}
                </div>
              )}
              <div className="thought-card__meta">
                <Author source={th.editedBy === 'human' ? 'human' : 'agent'} label={th.editedBy} />
                <span>·</span>
                <TimeAgo iso={th.updatedAt} />
                {th.version > 1 && <span title="Number of versions">· v{th.version}</span>}
              </div>
            </a>
          ))}
        </div>
      )}

      {list.data && list.data.total > 0 && (
        <div className="list-foot">
          <span>{list.data.total} {list.data.total === 1 ? 'thought' : 'thoughts'}</span>
          {list.data.total > t.pageSize && (
            <Pagination page={t.page} pageSize={t.pageSize} total={list.data.total} onPage={(p) => { t.setPage(p); window.scrollTo(0, 0); }} />
          )}
        </div>
      )}
    </main>
  );
}

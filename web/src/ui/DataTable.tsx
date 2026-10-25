import type { ReactNode } from 'react';
import { cx, IconButton } from './Button';
import { Select } from './Field';
import { Skeleton } from './Feedback';
import { Icon } from './Icon';

export type SortState<S extends string> = { sort: S; dir: 'asc' | 'desc' };

export type Column<T, S extends string> = {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Server-side sort key; makes the header clickable. */
  sort?: S;
  /** The first sort direction when this column is picked (dates and counts usually start descending). */
  firstDir?: 'asc' | 'desc';
  align?: 'left' | 'right';
  width?: number | string;
  /** On phones the primary cell spans the whole card on top. */
  primary?: boolean;
  hideOnMobile?: boolean;
};

export function DataTable<T, S extends string>({
  columns, rows, rowKey, onRowClick, sort, onSort, loading, empty, footer, rowMuted, label,
}: {
  columns: Column<T, S>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  sort?: SortState<S>;
  onSort?: (s: SortState<S>) => void;
  loading?: boolean;
  empty?: ReactNode;
  footer?: ReactNode;
  rowMuted?: (row: T) => boolean;
  label: string;
}) {
  const toggle = (c: Column<T, S>) => {
    if (!c.sort || !onSort) return;
    if (sort?.sort === c.sort) onSort({ sort: c.sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
    else onSort({ sort: c.sort, dir: c.firstDir ?? 'asc' });
  };
  const sortable = columns.filter((c) => c.sort);

  return (
    <div className="t-table-wrap t-table-wrap--cards">
      {sort && onSort && sortable.length > 0 && (
        <div className="t-mobile-sort t-row" style={{ marginBottom: 10 }}>
          <Select
            size="sm"
            aria-label="Sort by"
            value={sort.sort}
            onChange={(v) => {
              const c = sortable.find((x) => x.sort === v)!;
              onSort({ sort: v, dir: c.firstDir ?? 'asc' });
            }}
            options={sortable.map((c) => ({ value: c.sort!, label: `Sort: ${c.header}` }))}
            style={{ width: 'auto', flex: 1 }}
          />
          <IconButton
            variant="default"
            size="sm"
            icon={sort.dir === 'asc' ? 'arrowUp' : 'arrowDown'}
            label={sort.dir === 'asc' ? 'Ascending' : 'Descending'}
            onClick={() => onSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
          />
        </div>
      )}
      <div className="t-table-scroll">
        <table className={cx('t-table', loading && rows && 't-table__loading')} aria-label={label} aria-busy={loading}>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.sort === c.sort && !!c.sort;
                return (
                  <th
                    key={c.id}
                    data-align={c.align}
                    style={{ width: c.width }}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {c.sort && onSort ? (
                      <button type="button" className="t-table__sort" data-active={active} onClick={() => toggle(c)}>
                        {c.header}
                        <Icon name={active ? (sort!.dir === 'asc' ? 'arrowUp' : 'arrowDown') : 'sort'} style={{ opacity: active ? 1 : 0.45 }} />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {!rows &&
              Array.from({ length: 6 }, (_, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.id} data-primary={c.primary} data-hide-mobile={c.hideOnMobile}>
                      <Skeleton width={c.primary ? '70%' : '60%'} />
                    </td>
                  ))}
                </tr>
              ))}
            {rows?.map((r) => (
              <tr
                key={rowKey(r)}
                data-clickable={!!onRowClick}
                data-muted={rowMuted?.(r)}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick && (() => onRowClick(r))}
                onKeyDown={onRowClick && ((e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onRowClick(r);
                  }
                })}
              >
                {columns.map((c) => (
                  <td key={c.id} data-align={c.align} data-primary={c.primary} data-hide-mobile={c.hideOnMobile}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows?.length === 0 && empty}
      {footer && rows && rows.length > 0 && <div className="t-table-foot">{footer}</div>}
    </div>
  );
}

export const PAGE_SIZES = [10, 25, 50, 100] as const;

export function Pagination({
  page, pageSize, total, onPage, onPageSize,
}: { page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <>
      <div className="t-pagination__size">
        {onPageSize && (
          <>
            <span>Rows</span>
            <Select
              size="sm"
              aria-label="Rows per page"
              value={String(pageSize)}
              onChange={(v) => onPageSize(Number(v))}
              options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
            />
          </>
        )}
      </div>
      <nav className="t-pagination" aria-label="Pagination">
        <IconButton size="sm" icon="chevronsLeft" label="First page" disabled={page <= 1} onClick={() => onPage(1)} />
        <IconButton size="sm" icon="chevronLeft" label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)} />
        <span className="t-pagination__info">
          {from}–{to} of {total}
        </span>
        <IconButton size="sm" icon="chevronRight" label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)} />
        <IconButton size="sm" icon="chevronsRight" label="Last page" disabled={page >= pages} onClick={() => onPage(pages)} />
      </nav>
    </>
  );
}

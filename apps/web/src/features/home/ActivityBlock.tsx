import { ACTIVITY_DAYS } from '@tabula/shared/activity';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { fullDate } from '../../format';
import { REFRESH_MS, useInterval, useQuery } from '../../hooks/data';
import { href } from '../../router';
import type { ActivityDay, ActivityItem, ActivityPage, ActivityType, Project } from '../../types';
import { Alert, Button, Icon, type IconName, Segmented, Skeleton } from '../../ui';
import { Author, authorOf } from '../common';
import { CopyRefButton } from '../CopyRefButton';
import { ProjectTag } from './ProjectTag';

type Filter = 'all' | ActivityType;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'files', label: 'Files' },
  { value: 'reports', label: 'Reports' },
  { value: 'thoughts', label: 'Thoughts' },
  { value: 'notes', label: 'Notes' },
];
/** The browser's time zone: the server cuts the days where the user's days begin. */
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** One Show more goes through at most this many pages (about half a year) when they are empty. */
const MAX_PAGES_PER_CLICK = 12;

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "Today", "Yesterday", "7. 11.", or "7. 11. 2025" in another year. */
export function dayLabel(date: string, now = new Date()): string {
  if (date === isoDay(now)) return 'Today';
  if (date === isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday';
  const [y, m, d] = date.split('-').map(Number);
  return y === now.getFullYear() ? `${d}. ${m}.` : `${d}. ${m}. ${y}`;
}

function iconOf(it: ActivityItem): IconName {
  if (it.type === 'report') return it.attachment_id ? 'mic' : 'inbox';
  return it.type === 'file' ? 'layers' : it.type === 'thought' ? 'lightbulb' : 'fileText';
}

/** Where a row leads; editors get Home as their way back. */
function targetOf(it: ActivityItem): string {
  const home = href.home();
  switch (it.type) {
    case 'file': return href.file(it.project ?? '', it.path ?? it.title, home);
    case 'report': return it.attachment_id ? href.attachment(it.id, it.attachment_id, home) : href.report(it.id, undefined, home);
    case 'thought': return href.thought(it.id, home);
    case 'note': return href.note(it.id, home);
  }
}

/** Identifies a row for the merge of overlapping pages. */
const sameRow = (it: ActivityItem) => `${it.type}:${it.ref}:${it.id}:${it.attachment_id ?? ''}:${it.action}:${it.at}`;

/**
 * The pages' days in order. Pages loaded earlier can overlap the first page (it moves with the clock, the
 * older pages do not), so a day found twice becomes one heading and a row found twice one row.
 */
function joinDays(pages: ActivityPage[]): ActivityDay[] {
  const byDate = new Map<string, ActivityItem[]>();
  for (const day of pages.flatMap((p) => p.days)) {
    const items = byDate.get(day.date) ?? [];
    const seen = new Set(items.map(sameRow));
    byDate.set(day.date, [...items, ...day.items.filter((it) => !seen.has(sameRow(it)))]);
  }
  return [...byDate].map(([date, items]) => ({ date, items: items.sort((x, y) => y.at.localeCompare(x.at)) }));
}

/**
 * React keys for one day's rows that survive a refresh: a batch of files is known by its oldest file (it grows
 * at the top), any other row by its record and label. Rows alike get a number counted from the oldest.
 */
function rowKeys(items: ActivityItem[]): string[] {
  const used = new Map<string, number>();
  const keys = items.map(() => '');
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    const base = it.children?.length ? `batch:${it.project}:${it.by}:${it.children[it.children.length - 1]!.id}` : `${it.type}:${it.id}:${it.attachment_id ?? ''}:${it.action}`;
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    keys[i] = `${base}:${n}`;
  }
  return keys;
}

/** The timeline by day: 14 days, Show more for 14 older ones, a filter by type. */
export function ActivityBlock({ projects }: { projects: Project[] | undefined }) {
  const [filter, setFilter] = useState<Filter>('all');
  const type = filter === 'all' ? undefined : filter;
  const first = useQuery((s) => api.activity({ type, tz: TZ }, s), [type], { topics: ['reports', 'files', 'notes', 'thoughts'] });
  useInterval(first.reload, REFRESH_MS);
  // Pages loaded with Show more stay across refreshes; only another filter drops them.
  const [older, setOlder] = useState<{ filter: Filter; pages: ActivityPage[] }>({ filter: 'all', pages: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  useEffect(() => {
    setOlder({ filter, pages: [] });
    setMoreError(null);
  }, [filter]);
  // Fade only while a newly chosen filter's first page loads, never on a refresh.
  const [shown, setShown] = useState<Filter>('all');
  useEffect(() => {
    if (first.data) setShown(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first.data]);
  const switching = first.loading && shown !== filter;

  const head = first.data;
  const loaded = older.filter === shown ? older.pages : [];
  const pages = head ? [head, ...loaded] : [];
  const last = pages[pages.length - 1];
  const days = joinDays(pages);

  const showMore = async () => {
    let before = last?.next_before ?? null;
    if (!before) return;
    const asked = filter;
    setLoadingMore(true);
    setMoreError(null);
    const got: ActivityPage[] = [];
    const keep = () => {
      if (got.length && filterRef.current === asked) setOlder((o) => ({ filter: asked, pages: [...(o.filter === asked ? o.pages : []), ...got] }));
    };
    try {
      // A quiet stretch gives empty pages: go on until something shows up or nothing older is left.
      while (before && got.length < MAX_PAGES_PER_CLICK) {
        const page = await api.activity({ type: asked === 'all' ? undefined : asked, tz: TZ, before });
        got.push(page);
        if (page.days.length) break;
        before = page.next_before;
      }
      keep();
    } catch (e) {
      // The pages fetched before the failure stay, so a retry goes on from them.
      keep();
      if (filterRef.current === asked) setMoreError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section className="t-card home-block home-block--activity" aria-labelledby="home-activity">
      <div className="home-block__head">
        <h2 id="home-activity">Recent activity</h2>
      </div>
      <Segmented label="Show" value={filter} onChange={setFilter} options={FILTERS} block />
      {first.error && <Alert tone="danger">{first.error.message}</Alert>}
      {!head ? (
        <div className="t-stack">{[0, 1, 2].map((i) => <Skeleton key={i} height={40} />)}</div>
      ) : (
        <div className="activity" style={{ opacity: switching ? 0.6 : 1 }}>
          {days.length === 0 && <p className="home-block__empty">No activity in the last {ACTIVITY_DAYS * pages.length} days.</p>}
          {days.map((d) => (
            <div key={d.date} className="activity-day">
              <h3 className="activity-day__label">{dayLabel(d.date)}</h3>
              <ul className="activity-list">
                {(() => {
                  const keys = rowKeys(d.items);
                  return d.items.map((it, i) => <ActivityRow key={keys[i]} item={it} projects={projects} />);
                })()}
              </ul>
            </div>
          ))}
          {moreError && <Alert tone="danger">{moreError}</Alert>}
          {last?.next_before && (
            <Button className="activity-more" loading={loadingMore} disabled={switching} onClick={() => void showMore()}>Show more</Button>
          )}
        </div>
      )}
    </section>
  );
}

function ActivityRow({ item: it, projects }: { item: ActivityItem; projects: Project[] | undefined }) {
  const [open, setOpen] = useState(false);
  const files = it.children ?? [];
  const time = new Date(it.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const label = (
    <>
      <span className="activity-row__action">{it.action}</span>
      <span className="activity-row__title">{it.title}</span>
    </>
  );
  return (
    <li className="activity-row">
      <span className="activity-row__icon"><Icon name={iconOf(it)} /></span>
      <div className="activity-row__body">
        {files.length > 0 ? (
          <button type="button" className="activity-row__main" aria-expanded={open} onClick={() => setOpen(!open)}>
            {label}
            <span className="activity-row__chevron"><Icon name="chevronDown" /></span>
          </button>
        ) : (
          <a className="activity-row__main" href={targetOf(it)}>{label}</a>
        )}
        <div className="activity-row__meta">
          <ProjectTag id={it.project} projects={projects} none={null} />
          <Author {...authorOf(it.by)} />
          <time dateTime={it.at} title={fullDate(it.at)}>{time}</time>
        </div>
        {open && files.length > 0 && (
          <ul className="activity-files">
            {files.map((f) => (
              <li key={f.id}>
                <a className="t-truncate" href={href.file(it.project ?? '', f.path, href.home())}>{f.path}</a>
                <CopyRefButton id={f.id} size="sm" />
              </li>
            ))}
          </ul>
        )}
      </div>
      <CopyRefButton id={it.attachment_id ?? it.id} size="sm" />
    </li>
  );
}

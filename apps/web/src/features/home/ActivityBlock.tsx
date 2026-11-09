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
/** Days per page (the server's ACTIVITY_DAYS). */
const PAGE_DAYS = 14;
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

/** The pages' days in order; a day split by a page border (the first page moved past midnight) is joined. */
function joinDays(pages: ActivityPage[]): ActivityDay[] {
  const out: ActivityDay[] = [];
  for (const day of pages.flatMap((p) => p.days)) {
    const prev = out[out.length - 1];
    if (prev?.date === day.date) out[out.length - 1] = { date: day.date, items: [...prev.items, ...day.items] };
    else out.push(day);
  }
  return out;
}

/** The timeline by day: 14 days, Show more for 14 older ones, a filter by type. */
export function ActivityBlock({ projects }: { projects: Project[] | undefined }) {
  const [filter, setFilter] = useState<Filter>('all');
  const type = filter === 'all' ? undefined : filter;
  const first = useQuery((s) => api.activity({ type, tz: TZ }, s), [type], { topics: ['reports', 'files', 'notes', 'thoughts'] });
  useInterval(first.reload, REFRESH_MS);
  // Older pages from Show more; they belong to the first page whose next_before they continue.
  const [older, setOlder] = useState<{ after: string; pages: ActivityPage[] } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  useEffect(() => {
    setOlder(null);
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
  const pages = head ? [head, ...(older && older.after === head.next_before ? older.pages : [])] : [];
  const last = pages[pages.length - 1];
  const days = joinDays(pages);

  const showMore = async () => {
    const after = head?.next_before;
    let before = last?.next_before ?? null;
    if (!after || !before) return;
    const asked = filter;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const got: ActivityPage[] = [];
      // A quiet stretch gives empty pages: go on until something shows up or nothing older is left.
      while (before && got.length < MAX_PAGES_PER_CLICK) {
        const page = await api.activity({ type: asked === 'all' ? undefined : asked, tz: TZ, before });
        got.push(page);
        if (page.days.length) break;
        before = page.next_before;
      }
      if (filterRef.current !== asked) return;
      setOlder((o) => ({ after, pages: [...(o && o.after === after ? o.pages : []), ...got] }));
    } catch (e) {
      setMoreError((e as Error).message);
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
          {days.length === 0 && <p className="home-block__empty">No activity in the last {PAGE_DAYS * pages.length} days.</p>}
          {days.map((d) => (
            <div key={d.date} className="activity-day">
              <h3 className="activity-day__label">{dayLabel(d.date)}</h3>
              <ul className="activity-list">
                {d.items.map((it) => <ActivityRow key={`${it.type}:${it.ref}:${it.at}:${it.action}`} item={it} projects={projects} />)}
              </ul>
            </div>
          ))}
          {moreError && <Alert tone="danger">{moreError}</Alert>}
          {last?.next_before && (
            <Button className="activity-more" loading={loadingMore} onClick={() => void showMore()}>Show more</Button>
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

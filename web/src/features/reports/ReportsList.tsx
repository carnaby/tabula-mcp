import { api } from '../../api';
import { useClampPage, useDebounced, useQuery, useTableState } from '../../hooks/data';
import { href } from '../../router';
import { type Project, REPORT_STATUS_INFO, type ReportSort, type ReportStatus, type ReportSummary } from '../../types';
import { Alert, Badge, type BadgeTone, Button, ButtonLink, EmptyState, Icon, Pagination, SearchInput, Segmented, Skeleton } from '../../ui';
import { ProjectSelect, TimeAgo } from '../common';

type Filters = { q: string; status: 'open' | 'done' | 'all'; project: string };
export const STATUS_TONE: Record<ReportStatus, BadgeTone> = { new: 'accent', triaged: 'info', done: 'success' };

function Counts({ r }: { r: ReportSummary }) {
  const c = r.counts;
  const items: [number, 'image' | 'film' | 'mic' | 'aperture', string][] = [
    [c.image, 'image', 'photos'], [c.video, 'film', 'videos'], [c.audio, 'mic', 'voice notes'], [c.frame, 'aperture', 'frames'],
  ];
  return (
    <span className="report-card__counts">
      {items.filter(([n]) => n > 0).map(([n, icon, label]) => (
        <span key={icon} title={`${n} ${label}`}><Icon name={icon} /> {n}</span>
      ))}
    </span>
  );
}

/** Bug reports as cards (phones first); `project` fixes the project (the project page's tab). */
export function ReportsList({ project, projects }: { project?: string; projects: Project[] | undefined }) {
  const t = useTableState<ReportSort, Filters>(project ? 'project-reports' : 'reports', {
    sort: 'createdAt', dir: 'desc', pageSize: 25, filters: { q: '', status: 'open', project: '' },
  });
  const q = useDebounced(t.filters.q);
  const scope = project ?? t.filters.project;
  const list = useQuery(
    (s) => api.reports({ project: scope || undefined, status: t.filters.status, q, page: t.page, pageSize: t.pageSize, sort: t.sort, dir: t.dir }, s),
    [scope, t.filters.status, q, t.page, t.pageSize, t.sort, t.dir],
    { topics: ['reports'] },
  );
  useClampPage(list.data?.total, t.page, t.pageSize, t.setPage);
  const multiProject = !project && (projects?.filter((p) => p.id !== 'global').length ?? 0) > 1;
  // On a project's tab, reports remember it so their back button returns here (the global list is the default).
  const from = project ? href.project(project, 'reports') : undefined;

  return (
    <div className="t-stack">
      <div className="toolbar">
        <SearchInput value={t.filters.q} onChange={(v) => t.setFilter('q', v)} placeholder="Search reports" />
        {multiProject && (
          <ProjectSelect projects={projects?.filter((p) => p.id !== 'global')} value={t.filters.project} onChange={(v) => t.setFilter('project', v)} allowAll />
        )}
        <Segmented
          label="Status"
          value={t.filters.status}
          onChange={(v) => t.setFilter('status', v)}
          options={[{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }, { value: 'all', label: 'All' }]}
        />
        <span className="t-spacer" />
        <ButtonLink href={href.report('new', scope || undefined, from)} variant="primary" icon="plus">New report</ButtonLink>
      </div>

      {list.error && <Alert tone="danger">{list.error.message}</Alert>}
      {!list.data && <div className="t-stack">{[0, 1, 2].map((i) => <Skeleton key={i} height={76} style={{ borderRadius: 12 }} />)}</div>}
      {list.data?.items.length === 0 &&
        (t.filters.q || t.filters.status !== 'open' || t.filters.project ? (
          <EmptyState icon="search" title="No reports match" action={<Button onClick={t.resetFilters}>Clear filters</Button>} />
        ) : (
          <EmptyState icon="bug" title="No open bug reports" action={<ButtonLink href={href.report('new', scope || undefined, from)} variant="primary" icon="plus">Report a bug</ButtonLink>}>
            Testing on the phone? Record the screen, say what's wrong, add it here. An agent turns it into tasks.
          </EmptyState>
        ))}
      {list.data && list.data.items.length > 0 && (
        <div className="report-list" style={{ opacity: list.loading ? 0.6 : 1 }}>
          {list.data.items.map((r) => (
            <a key={r.id} href={href.report(r.id, undefined, from)} className="t-card t-card--interactive report-card">
              <div className="report-card__top">
                <span className="report-card__title">{r.title}</span>
                <Badge tone={STATUS_TONE[r.status]}>{REPORT_STATUS_INFO[r.status].label}</Badge>
              </div>
              <div className="report-card__meta">
                {!project && <Badge tone="outline" icon="folder">{r.projectId}</Badge>}
                <Counts r={r} />
                {r.triage && r.status !== 'done' && <Badge icon="bot">tasks ready</Badge>}
                <span className="t-spacer" />
                <span className="t-subtle"><TimeAgo iso={r.createdAt} /></span>
              </div>
            </a>
          ))}
        </div>
      )}
      {list.data && list.data.total > t.pageSize && (
        <div className="list-foot">
          <span>{list.data.total} reports</span>
          <Pagination page={t.page} pageSize={t.pageSize} total={list.data.total} onPage={t.setPage} />
        </div>
      )}
    </div>
  );
}

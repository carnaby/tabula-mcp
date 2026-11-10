import { age } from '../../format';
import { href } from '../../router';
import type { Dashboard } from '../../types';
import { Skeleton } from '../../ui';
import { ActivityBars } from './ActivityBars';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const active = (iso: string) => {
  const a = age(iso);
  return a === 'just now' ? 'active just now' : `active ${a} ago`;
};

/** The projects by last activity, with their files, open reports and their changes over the last 14 days. */
export function ProjectsBlock({ dashboard, failed }: { dashboard: Dashboard | undefined; failed?: boolean }) {
  // One scale for every project: the busiest day of any of them is full height.
  const max = Math.max(0, ...(dashboard?.projects.flatMap((p) => p.activity) ?? []));
  return (
    <section className="t-card home-block home-block--projects" aria-labelledby="home-projects">
      <div className="home-block__head">
        <h2 id="home-projects">Projects</h2>
      </div>
      {!dashboard ? (
        failed ? <p className="home-block__empty">Could not load.</p> : <Skeleton height={120} />
      ) : dashboard.projects.length === 0 ? (
        <p className="home-block__empty">No projects yet.</p>
      ) : (
        <ul className="home-projects">
          {dashboard.projects.map((p) => (
            <li key={p.id}>
              <a className="home-project" href={href.project(p.id)}>
                <span className="home-project__name">{p.name || p.id}</span>
                <span className="home-project__meta">
                  {active(p.last_activity_at)} · {count(p.file_count, 'file', 'files')} · {count(p.open_reports, 'open report', 'open reports')}
                </span>
                <ActivityBars counts={p.activity} max={max} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

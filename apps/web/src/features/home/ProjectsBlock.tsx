import { age } from '../../format';
import { href } from '../../router';
import type { Dashboard } from '../../types';
import { Skeleton } from '../../ui';
import { recallMeter } from '../RecallPanel';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const active = (iso: string) => {
  const a = age(iso);
  return a === 'just now' ? 'active just now' : `active ${a} ago`;
};

/** The projects by last activity, with their files, open reports and how full their recall is. */
export function ProjectsBlock({ dashboard }: { dashboard: Dashboard | undefined }) {
  return (
    <section className="t-card home-block home-block--projects" aria-labelledby="home-projects">
      <div className="home-block__head">
        <h2 id="home-projects">Projects</h2>
      </div>
      {!dashboard ? (
        <Skeleton height={120} />
      ) : dashboard.projects.length === 0 ? (
        <p className="home-block__empty">No projects yet.</p>
      ) : (
        <ul className="home-projects">
          {dashboard.projects.map((p) => {
            const budget = dashboard.recall_budget;
            const { pct, level } = recallMeter(p.recall_tokens, budget);
            const recall = `Recall ~${p.recall_tokens} of ${budget} tokens`;
            return (
              <li key={p.id}>
                <a className="home-project" href={href.project(p.id)}>
                  <span className="home-project__name">{p.name || p.id}</span>
                  <span className="home-project__meta">
                    {active(p.last_activity_at)} · {count(p.file_count, 'file', 'files')} · {count(p.open_reports, 'open report', 'open reports')}
                  </span>
                  <span className="home-project__meter" role="img" aria-label={recall} title={recall}>
                    <span className="meter__bar">
                      <span className="meter__fill" data-level={level} style={{ width: `${pct}%` }} />
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

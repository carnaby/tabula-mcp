import { api } from '../api';
import { WaitingBlock } from '../features/home/WaitingBlock';
import { PageHeader } from '../features/PageHeader';
import { REFRESH_MS, useInterval, useQuery } from '../hooks/data';
import type { Project } from '../types';
import { Alert } from '../ui';

/** Home reloads every minute and when the window regains focus (useQuery), like the worker indicator. */
export function HomePage({ projects }: { projects: Project[] | undefined }) {
  const dash = useQuery((s) => api.dashboard(s), [], { topics: ['reports', 'files', 'projects', 'memories'] });
  useInterval(dash.reload, REFRESH_MS);

  return (
    <main className="content content--wide">
      <PageHeader title="Home" description="What waits for you, what changed and what needs a look." />
      {dash.error && <Alert tone="danger">{dash.error.message}</Alert>}
      <div className="home">
        <div className="home__main">
          <WaitingBlock dashboard={dash.data} projects={projects} onChanged={dash.reload} />
        </div>
        <div className="home__side" />
      </div>
    </main>
  );
}

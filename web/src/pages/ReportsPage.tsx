import { ReportsList } from '../features/reports/ReportsList';
import type { Project } from '../types';

export function ReportsPage({ projects }: { projects: Project[] | undefined }) {
  return (
    <main className="content content--wide">
      <div className="page-head">
        <div className="page-head__text">
          <h1>Bug reports</h1>
          <p>Bugs you captured while testing — text, photos, screen recordings and voice. Ask Claude to “process the bug reports” and it writes the tasks here.</p>
        </div>
      </div>
      <ReportsList projects={projects} />
    </main>
  );
}

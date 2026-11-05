import { PageHeader } from '../features/PageHeader';
import { ReportsList } from '../features/reports/ReportsList';
import type { Project } from '../types';

export function ReportsPage({ projects }: { projects: Project[] | undefined }) {
  return (
    <main className="content content--wide">
      <PageHeader
        title="Bug reports"
        description="Bugs you captured while testing."
        more="Text, photos, screen recordings and voice. Ask Claude to “process the bug reports” and it writes the tasks here."
      />
      <ReportsList projects={projects} />
    </main>
  );
}

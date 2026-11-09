import { PageHeader } from '../features/PageHeader';
import { ReportsList } from '../features/reports/ReportsList';
import type { Project } from '../types';

export function ReportsPage({ projects }: { projects: Project[] | undefined }) {
  return (
    <main className="content content--wide">
      <PageHeader
        title="Reports"
        description="Bugs, recordings and notes with media."
        more="Text, photos, screen recordings, voice notes and recordings of meetings or conversations. Ask Claude to “process the reports” and it writes the triage here: the cause and tasks for a bug, a summary, decisions and tasks for anything else."
      />
      <ReportsList projects={projects} />
    </main>
  );
}

import { FilesPanel } from '../features/FilesPanel';
import { FileView } from '../features/FileView';
import { PageHeader } from '../features/PageHeader';
import { RecallPanel } from '../features/RecallPanel';
import { SetupPanel } from '../features/SetupPanel';
import { StatePanel } from '../features/StatePanel';
import { ReportsList } from '../features/reports/ReportsList';
import { api } from '../api';
import { useQuery } from '../hooks/data';
import { href, type ProjectTab } from '../router';
import type { Project } from '../types';
import { Badge, ButtonLink, EmptyState, Skeleton, Tabs } from '../ui';

export function ProjectPage({
  project, tab, path, from, projects,
}: { project: string; tab: ProjectTab; path?: string; from?: string; projects: Project[] | undefined }) {
  const p = projects?.find((x) => x.id === project);
  const reportCounts = useQuery((s) => api.reportCounts(s), [], { topics: ['reports'] });
  if (projects && !p) {
    return (
      <main className="content">
        <EmptyState icon="folder" title={`No project “${project}”`} action={<ButtonLink href={href.thoughts()}>Back</ButtonLink>}>
          It may have been renamed, or the link is wrong.
        </EmptyState>
      </main>
    );
  }

  return (
    <main className="content content--wide">
      <PageHeader
        key={project}
        title={p ? p.name : <Skeleton width={200} height={28} />}
        chip={<Badge tone="outline">{project}</Badge>}
        description={p ? p.description || 'No description yet — add one in Setup.' : undefined}
        clamp={!!p?.description}
        tabs={
          <Tabs
            label="Project sections"
            current={tab}
            items={[
              { id: 'state', label: 'State', href: href.project(project), icon: 'sparkles' },
              { id: 'reports', label: 'Bug reports', href: href.project(project, 'reports'), icon: 'bug', count: reportCounts.data?.[project] },
              { id: 'files', label: 'Files', href: href.project(project, 'files'), icon: 'fileText', count: p?.file_count },
              { id: 'recall', label: 'Recall preview', href: href.project(project, 'recall'), icon: 'eye' },
              { id: 'setup', label: 'Setup', href: href.project(project, 'setup'), icon: 'sliders' },
            ]}
          />
        }
      />
      {tab === 'state' && <StatePanel project={project} />}
      {tab === 'files' && (path ? <FileView project={project} path={path} from={from} /> : <FilesPanel key={project} project={project} />)}
      {tab === 'reports' && <ReportsList project={project} projects={projects} />}
      {tab === 'recall' && <RecallPanel project={project} />}
      {tab === 'setup' && <SetupPanel project={p} />}
    </main>
  );
}

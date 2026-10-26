import { FilesPanel } from '../features/FilesPanel';
import { FileView } from '../features/FileView';
import { RecallPanel } from '../features/RecallPanel';
import { SetupPanel } from '../features/SetupPanel';
import { StatePanel } from '../features/StatePanel';
import { href, type ProjectTab } from '../router';
import type { Project } from '../types';
import { Badge, ButtonLink, EmptyState, Skeleton, Tabs } from '../ui';

export function ProjectPage({
  project, tab, path, projects,
}: { project: string; tab: ProjectTab; path?: string; projects: Project[] | undefined }) {
  const p = projects?.find((x) => x.id === project);
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
      <div className="page-head">
        <div className="page-head__text">
          <h1>
            {p ? p.name : <Skeleton width={200} height={28} />}
            <Badge tone="outline">{project}</Badge>
          </h1>
          <p>{p?.description || 'No description yet — add one in Setup.'}</p>
        </div>
      </div>
      <Tabs
        label="Project sections"
        current={tab}
        items={[
          { id: 'state', label: 'State', href: href.project(project), icon: 'sparkles' },
          { id: 'files', label: 'Files', href: href.project(project, 'files'), icon: 'fileText', count: p?.file_count },
          { id: 'recall', label: 'Recall preview', href: href.project(project, 'recall'), icon: 'eye' },
          { id: 'setup', label: 'Setup', href: href.project(project, 'setup'), icon: 'sliders' },
        ]}
      />
      {tab === 'state' && <StatePanel project={project} />}
      {tab === 'files' && (path ? <FileView project={project} path={path} /> : <FilesPanel project={project} />)}
      {tab === 'recall' && <RecallPanel project={project} />}
      {tab === 'setup' && <SetupPanel project={p} />}
    </main>
  );
}

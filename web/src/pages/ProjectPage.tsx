import { MemoriesTable } from '../features/MemoriesTable';
import { RecallPanel } from '../features/RecallPanel';
import { SetupPanel } from '../features/SetupPanel';
import { href } from '../router';
import type { Project } from '../types';
import { Badge, ButtonLink, EmptyState, Skeleton, Tabs } from '../ui';

type Tab = 'memories' | 'recall' | 'setup';

export function ProjectPage({ project, tab, projects }: { project: string; tab: Tab; projects: Project[] | undefined }) {
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
  const isGlobal = project === 'global';

  return (
    <main className="content content--wide">
      <div className="page-head">
        <div className="page-head__text">
          <h1>
            {p ? (isGlobal ? 'Global' : p.name) : <Skeleton width={200} height={28} />}
            <Badge tone="outline">{isGlobal ? 'every project' : project}</Badge>
          </h1>
          <p>{isGlobal ? 'Rules and notes included in every project’s recall.' : p?.description || 'No description yet — add one in Setup.'}</p>
        </div>
      </div>
      <Tabs
        label="Project sections"
        current={tab}
        items={[
          { id: 'memories', label: 'Memories', href: href.project(project), icon: 'layers', count: p?.memory_count },
          { id: 'recall', label: 'Recall preview', href: href.project(project, 'recall'), icon: 'eye' },
          { id: 'setup', label: 'Setup', href: href.project(project, 'setup'), icon: 'sliders' },
        ]}
      />
      {tab === 'memories' && <MemoriesTable project={project} projects={projects} />}
      {tab === 'recall' && <RecallPanel project={project} />}
      {tab === 'setup' && <SetupPanel project={p} />}
    </main>
  );
}

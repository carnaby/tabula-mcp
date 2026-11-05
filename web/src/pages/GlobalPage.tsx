import { MemoriesTable } from '../features/MemoriesTable';
import { PageHeader } from '../features/PageHeader';
import { RecallPanel } from '../features/RecallPanel';
import { type GlobalTab, href } from '../router';
import type { Project } from '../types';
import { Tabs } from '../ui';

export function GlobalPage({ tab, projects }: { tab: GlobalTab; projects: Project[] | undefined }) {
  const global = projects?.find((p) => p.id === 'global');
  return (
    <main className="content content--wide">
      <PageHeader
        title="Global"
        description="Rules that apply to every project."
        more={
          <>
            Every recall starts with them; agents add one only when you explicitly ask. Rules and gotchas go into every
            recall in full, facts and decisions as titles. Keep them few and general — what belongs to one project lives
            in that project's files.
          </>
        }
        tabs={
          <Tabs
            label="Global sections"
            current={tab}
            items={[
              { id: 'rules', label: 'Rules', href: href.global(), icon: 'layers', count: global?.memory_count },
              { id: 'recall', label: 'Recall preview', href: href.global('recall'), icon: 'eye' },
            ]}
          />
        }
      />
      {tab === 'rules' && <MemoriesTable project="global" projects={projects?.filter((p) => p.id === 'global')} />}
      {tab === 'recall' && <RecallPanel project="global" />}
    </main>
  );
}

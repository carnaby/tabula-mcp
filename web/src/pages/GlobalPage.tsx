import { api } from '../api';
import { MemoriesTable } from '../features/MemoriesTable';
import { MemoryDialog } from '../features/MemoryDialog';
import { PageHeader } from '../features/PageHeader';
import { RecallPanel } from '../features/RecallPanel';
import { useQuery } from '../hooks/data';
import { type GlobalTab, href } from '../router';
import type { Project } from '../types';
import { Alert, Tabs } from '../ui';

export function GlobalPage({ tab, memory, projects }: { tab: GlobalTab; memory?: string; projects: Project[] | undefined }) {
  const global = projects?.find((p) => p.id === 'global');
  // #/global?memory=<id> (where a rule's reference leads) opens that rule in its dialog over the page.
  const linked = useQuery((s) => api.memory(memory!, s), [memory], { enabled: !!memory, refetchOnFocus: false });
  // replace(): closing leaves #/global, so Back and reload don't open the dialog again.
  const closeLinked = () => window.location.replace(href.global(tab));
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
      {memory && linked.error && <Alert tone="danger">{linked.error.message}</Alert>}
      {tab === 'rules' && <MemoriesTable project="global" projects={projects?.filter((p) => p.id === 'global')} />}
      {tab === 'recall' && <RecallPanel project="global" />}
      <MemoryDialog state={memory && linked.data ? { mode: 'edit', memory: linked.data } : null} projects={projects} onClose={closeLinked} />
    </main>
  );
}

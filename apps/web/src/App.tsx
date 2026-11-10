import { useEffect, useState } from 'react';
import { api } from './api';
import { WorkerIndicator } from './features/reports/WorkerIndicator';
import { REFRESH_MS, useInterval, useQuery } from './hooks/data';
import { Sidebar } from './layout/Sidebar';
import { GlobalPage } from './pages/GlobalPage';
import { HomePage } from './pages/HomePage';
import { NewProjectDialog } from './pages/NewProjectDialog';
import { NoteEditorPage } from './pages/NoteEditorPage';
import { NotesPage } from './pages/NotesPage';
import { ProjectPage } from './pages/ProjectPage';
import { ReportPage } from './pages/ReportPage';
import { ReportsPage } from './pages/ReportsPage';
import { SearchPage } from './pages/SearchPage';
import { ThoughtEditorPage } from './pages/ThoughtEditorPage';
import { ThoughtsPage } from './pages/ThoughtsPage';
import { href, navigate, type Route, useRoute } from './router';
import type { Project } from './types';
import { ButtonLink, EmptyState, IconButton, LogoMark } from './ui';

function title(route: Route, projects: Project[] | undefined): string {
  switch (route.name) {
    case 'home': return 'Home';
    case 'thoughts': return 'Thoughts';
    case 'thought': return route.id === 'new' ? 'New thought' : 'Thought';
    case 'notes': return 'Notes';
    case 'note': return route.id === 'new' ? 'New note' : 'Note';
    case 'global': return 'Global';
    case 'search': return 'Search';
    case 'reports': return 'Reports';
    case 'report': return route.id === 'new' ? 'New report' : 'Report';
    case 'project': return projects?.find((x) => x.id === route.project)?.name ?? route.project;
    default: return 'Tabula';
  }
}

export function App() {
  const route = useRoute();
  const projects = useQuery((s) => api.projects(s), [], { topics: ['projects', 'memories', 'files'] });
  // The transcription worker for the header: one request for the top bar and the sidebar, again every minute.
  const worker = useQuery((s) => api.transcriptionStatus(s), [], { topics: ['reports'] });
  useInterval(worker.reload, REFRESH_MS);
  const [navOpen, setNavOpen] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const routeKey = JSON.stringify(route);

  useEffect(() => setNavOpen(false), [routeKey]);
  useEffect(() => {
    document.title = `${title(route, projects.data)} · Tabula`;
  }, [routeKey, projects.data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (window.location.hash.startsWith('#/search')) document.querySelector<HTMLInputElement>('.search-hero input')?.focus();
        else navigate(href.search());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="shell" data-nav-open={navOpen}>
      <Sidebar route={route} projects={projects.data} worker={worker.data} onClose={() => setNavOpen(false)} onNewProject={() => setNewProject(true)} />
      <div className="shell__backdrop" onClick={() => setNavOpen(false)} />
      <div className="shell__main">
        <header className="topbar">
          <IconButton icon="menu" label="Open menu" onClick={() => setNavOpen(true)} />
          <a href={href.home()} aria-label="Tabula home" className="topbar__logo"><LogoMark size={24} /></a>
          <span className="topbar__title">{title(route, projects.data)}</span>
          <WorkerIndicator status={worker.data} align="end" className="worker-ind--topbar" />
          <IconButton icon="search" label="Search" onClick={() => navigate(href.search())} />
        </header>
        <Page key={route.name === 'search' ? 'search' : routeKey} route={route} projects={projects.data} />
      </div>
      <NewProjectDialog
        open={newProject}
        onClose={() => setNewProject(false)}
        onCreated={(p) => {
          setNewProject(false);
          navigate(href.project(p.id, 'setup'));
        }}
      />
    </div>
  );
}

function Page({ route, projects }: { route: Route; projects: Project[] | undefined }) {
  switch (route.name) {
    case 'home': return <HomePage projects={projects} />;
    case 'thoughts': return <ThoughtsPage />;
    case 'thought': return <ThoughtEditorPage id={route.id} from={route.from} />;
    case 'notes': return <NotesPage />;
    case 'note': return <NoteEditorPage id={route.id} from={route.from} />;
    case 'global': return <GlobalPage tab={route.tab} memory={route.memory} projects={projects} />;
    case 'search': return <SearchPage q={route.q} projects={projects} />;
    case 'reports': return <ReportsPage projects={projects} />;
    case 'report': return <ReportPage id={route.id} project={route.project} from={route.from} attachment={route.attachment} projects={projects} />;
    case 'project': return <ProjectPage project={route.project} tab={route.tab} path={route.path} from={route.from} projects={projects} />;
    default:
      return (
        <main className="content">
          <EmptyState icon="alert" title="Page not found" action={<ButtonLink href={href.home()}>Go to Home</ButtonLink>}>
            This address doesn't lead anywhere in Tabula.
          </EmptyState>
        </main>
      );
  }
}

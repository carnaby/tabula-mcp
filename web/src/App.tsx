import { useEffect, useState } from 'react';
import { api } from './api';
import { useQuery } from './hooks/data';
import { Sidebar } from './layout/Sidebar';
import { MemoriesPage } from './pages/MemoriesPage';
import { NewProjectDialog } from './pages/NewProjectDialog';
import { NoteEditorPage } from './pages/NoteEditorPage';
import { ProjectPage } from './pages/ProjectPage';
import { SearchPage } from './pages/SearchPage';
import { ThoughtEditorPage } from './pages/ThoughtEditorPage';
import { ThoughtsPage } from './pages/ThoughtsPage';
import { href, navigate, type Route, useRoute } from './router';
import type { Project } from './types';
import { EmptyState, IconButton, ButtonLink, LogoMark } from './ui';

function title(route: Route, projects: Project[] | undefined): string {
  switch (route.name) {
    case 'thoughts': return 'Thoughts';
    case 'thought': return route.id === 'new' ? 'New thought' : 'Thought';
    case 'memories': return 'All memories';
    case 'search': return 'Search';
    case 'project':
    case 'note': {
      const p = projects?.find((x) => x.id === route.project);
      return route.project === 'global' ? 'Global' : (p?.name ?? route.project);
    }
    default: return 'Tabula';
  }
}

export function App() {
  const route = useRoute();
  const projects = useQuery((s) => api.projects(s), [], { topics: ['projects', 'memories', 'notes'] });
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
      <Sidebar route={route} projects={projects.data} onClose={() => setNavOpen(false)} onNewProject={() => setNewProject(true)} />
      <div className="shell__backdrop" onClick={() => setNavOpen(false)} />
      <div className="shell__main">
        <header className="topbar">
          <IconButton icon="menu" label="Open menu" onClick={() => setNavOpen(true)} />
          <LogoMark size={24} />
          <span className="topbar__title">{title(route, projects.data)}</span>
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
    case 'thoughts': return <ThoughtsPage />;
    case 'thought': return <ThoughtEditorPage id={route.id} />;
    case 'memories': return <MemoriesPage projects={projects} />;
    case 'search': return <SearchPage q={route.q} projects={projects} />;
    case 'project': return <ProjectPage project={route.project} tab={route.tab} projects={projects} />;
    case 'note': return <NoteEditorPage project={route.project} id={route.id} />;
    default:
      return (
        <main className="content">
          <EmptyState icon="alert" title="Page not found" action={<ButtonLink href={href.thoughts()}>Go to Thoughts</ButtonLink>}>
            This address doesn't lead anywhere in Tabula.
          </EmptyState>
        </main>
      );
  }
}

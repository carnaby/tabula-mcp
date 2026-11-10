import { useEffect, useState } from 'react';

export type ProjectTab = 'state' | 'reports' | 'files' | 'recall' | 'setup';
export type GlobalTab = 'rules' | 'recall';
export type Route =
  | { name: 'home' }
  | { name: 'thoughts' }
  | { name: 'thought'; id: string | 'new'; from?: string }
  | { name: 'notes' }
  | { name: 'note'; id: string | 'new'; from?: string }
  | { name: 'global'; tab: GlobalTab; memory?: string }
  | { name: 'search'; q: string }
  | { name: 'reports' }
  /** `project` preselects the project of a new report; `from` is where the back button leads; `attachment` is shown first. */
  | { name: 'report'; id: string | 'new'; project?: string; from?: string; attachment?: string }
  | { name: 'project'; project: string; tab: ProjectTab; path?: string; from?: string }
  | { name: 'notFound' };

/** `?a=1&b=2` from the defined values, or '' when there are none. */
const query = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return q ? `?${q}` : '';
};

/**
 * Editor links take an optional `from`: the address of the page the link is on, so the editor's back button returns
 * there (a project's reports, a search with its query). It travels in the address, so a reloaded or shared link
 * keeps it; without it the back button goes to the record type's own list.
 */
export const href = {
  home: () => '#/',
  thoughts: () => '#/thoughts',
  thought: (id: string, from?: string) => `#/thoughts/${id}${query({ from })}`,
  notes: () => '#/notes',
  note: (id: string, from?: string) => `#/notes/${id}${query({ from })}`,
  global: (tab: GlobalTab = 'rules') => `#/global${tab === 'rules' ? '' : `/${tab}`}`,
  reports: () => '#/reports',
  report: (id: string, project?: string, from?: string) => `#/reports/${id}${query({ project, from })}`,
  search: (q = '') => `#/search${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  project: (p: string, tab: ProjectTab = 'state') =>
    `#/p/${encodeURIComponent(p)}${tab === 'state' ? '' : `/${tab}`}`,
  file: (p: string, path: string, from?: string) => `#/p/${encodeURIComponent(p)}/files${query({ path, from })}`,
  /** A global rule in its dialog over the Global page: where a rule's reference leads. */
  memory: (id: string) => `#/global${query({ memory: id })}`,
  /** A report opened on one attachment: a frame is selected and its video waits at that moment. */
  attachment: (reportId: string, id: string, from?: string) => `#/reports/${reportId}${query({ attachment: id, from })}`,
};

export function parse(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  let parts: string[];
  try {
    parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { name: 'notFound' };
  }
  const params = new URLSearchParams(query);
  const [a, b, c, d] = parts;
  const from = params.get('from') ?? undefined;
  // The start page; Thoughts keep their own address, so old links still open them.
  if (!a) return { name: 'home' };
  if (a === 'thoughts') return b ? { name: 'thought', id: b, from } : { name: 'thoughts' };
  if (a === 'notes') return b ? { name: 'note', id: b, from } : { name: 'notes' };
  if (a === 'global') return { name: 'global', tab: b === 'recall' ? 'recall' : 'rules', memory: params.get('memory') ?? undefined };
  if (a === 'search') return { name: 'search', q: params.get('q') ?? '' };
  if (a === 'reports') {
    return b
      ? { name: 'report', id: b, project: params.get('project') ?? undefined, from, attachment: params.get('attachment') ?? undefined }
      : { name: 'reports' };
  }
  // Links from earlier versions of the UI.
  if (a === 'memories' && !b) return { name: 'global', tab: 'rules' };
  if (a === 'recall' && !b) return { name: 'global', tab: 'recall' };
  if (a === 'p' && b === 'global') return { name: 'global', tab: c === 'recall' ? 'recall' : 'rules' };
  if (a === 'p' && b) {
    if (!c) return { name: 'project', project: b, tab: 'state' };
    if (c === 'notes') return d ? { name: 'note', id: d } : { name: 'notes' };
    if (c === 'files') return { name: 'project', project: b, tab: 'files', path: params.get('path') ?? undefined, from };
    if (c === 'state' || c === 'reports' || c === 'recall' || c === 'setup') return { name: 'project', project: b, tab: c };
  }
  return { name: 'notFound' };
}

/**
 * Where an editor's back button leads: the `from` address when it is a list page of this app, else `fallback`.
 * Only list-like pages are accepted, so a crafted link can't send the button somewhere odd (or into a loop).
 * With `projects`, the label names a project by its name instead of its slug.
 */
export function backTarget(
  from: string | undefined,
  fallback: string,
  projects?: readonly { id: string; name: string }[],
): { href: string; label: string } {
  const name = (slug: string) => projects?.find((p) => p.id === slug)?.name || slug;
  const target = from?.startsWith('#/') ? from : fallback;
  const label = backLabel(parse(target), name);
  if (label) return { href: target, label };
  return { href: fallback, label: backLabel(parse(fallback), name) ?? 'Back' };
}

/**
 * The section a page belongs to for the navigation: an editor opened from a project's list (its `from`) belongs to
 * that project, everything else to itself.
 */
export function sectionOf(route: Route): Route {
  const from = 'from' in route && route.from?.startsWith('#/') ? parse(route.from) : null;
  return from?.name === 'project' ? from : route;
}

function backLabel(route: Route, name: (slug: string) => string): string | null {
  switch (route.name) {
    case 'home': return 'Back to Home';
    case 'thoughts': return 'Back to Thoughts';
    case 'notes': return 'Back to Notes';
    case 'reports': return 'Back to Reports';
    case 'global': return 'Back to Global';
    case 'search': return route.q ? `Back to search “${route.q}”` : 'Back to Search';
    case 'project':
      if (route.path) return null;
      if (route.tab === 'reports') return `Back to ${name(route.project)} reports`;
      if (route.tab === 'files') return `Back to ${name(route.project)} files`;
      return `Back to ${name(route.project)}`;
    default: return null;
  }
}

/** Editors with unsaved changes register here; navigation asks before leaving them. */
type Guard = () => boolean;
const guards = new Set<Guard>();
export function addNavigationGuard(g: Guard) {
  guards.add(g);
  return () => {
    guards.delete(g);
  };
}
const blocked = () => [...guards].some((g) => g());
const LEAVE = 'You have unsaved changes. Leave without saving?';

export function navigate(to: string) {
  if (to === window.location.hash) return;
  window.location.hash = to;
}

export function useRoute(): Route {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    let last = window.location.hash;
    const onChange = () => {
      const next = window.location.hash;
      if (next === last) return;
      // Hash routing can't cancel a navigation, so undo it if the user wants to stay.
      if (blocked() && !window.confirm(LEAVE)) {
        history.replaceState(null, '', last || '#/');
        return;
      }
      last = next;
      setHash(next);
      window.scrollTo(0, 0);
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (blocked()) e.preventDefault();
    };
    window.addEventListener('hashchange', onChange);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);
  return parse(hash);
}

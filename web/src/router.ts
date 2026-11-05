import { useEffect, useState } from 'react';

export type ProjectTab = 'state' | 'reports' | 'files' | 'recall' | 'setup';
export type GlobalTab = 'rules' | 'recall';
export type Route =
  | { name: 'thoughts' }
  | { name: 'thought'; id: string | 'new'; from?: string }
  | { name: 'notes' }
  | { name: 'note'; id: string | 'new'; from?: string }
  | { name: 'global'; tab: GlobalTab }
  | { name: 'search'; q: string }
  | { name: 'reports' }
  /** `project` preselects the project of a new report; `from` is where the back button leads. */
  | { name: 'report'; id: string | 'new'; project?: string; from?: string }
  | { name: 'project'; project: string; tab: ProjectTab; path?: string; from?: string }
  | { name: 'notFound' };

/** `?a=1&b=2` from the defined values, or '' when there are none. */
const query = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return q ? `?${q}` : '';
};

/**
 * Editor links take an optional `from`: the address of the page the link is on, so the editor's back button returns
 * there (a project's bug reports, a search with its query). It travels in the address, so a reloaded or shared link
 * keeps it; without it the back button goes to the record type's own list.
 */
export const href = {
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
  if (!a || a === 'thoughts') return b ? { name: 'thought', id: b, from } : { name: 'thoughts' };
  if (a === 'notes') return b ? { name: 'note', id: b, from } : { name: 'notes' };
  if (a === 'global') return { name: 'global', tab: b === 'recall' ? 'recall' : 'rules' };
  if (a === 'search') return { name: 'search', q: params.get('q') ?? '' };
  if (a === 'reports') return b ? { name: 'report', id: b, project: params.get('project') ?? undefined, from } : { name: 'reports' };
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
 */
export function backTarget(from: string | undefined, fallback: string): { href: string; label: string } {
  const target = from?.startsWith('#/') ? from : fallback;
  const route = parse(target);
  const label = backLabel(route);
  if (label) return { href: target, label };
  return { href: fallback, label: backLabel(parse(fallback)) ?? 'Back' };
}

function backLabel(route: Route): string | null {
  switch (route.name) {
    case 'thoughts': return 'Back to Thoughts';
    case 'notes': return 'Back to Notes';
    case 'reports': return 'Back to Bug reports';
    case 'global': return 'Back to Global';
    case 'search': return route.q ? `Back to search “${route.q}”` : 'Back to Search';
    case 'project':
      if (route.path) return null;
      if (route.tab === 'reports') return `Back to ${route.project} bug reports`;
      if (route.tab === 'files') return `Back to ${route.project} files`;
      return `Back to ${route.project}`;
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

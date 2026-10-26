import { useEffect, useState } from 'react';

export type ProjectTab = 'state' | 'files' | 'recall' | 'setup';
export type GlobalTab = 'rules' | 'recall';
export type Route =
  | { name: 'thoughts' }
  | { name: 'thought'; id: string | 'new' }
  | { name: 'notes' }
  | { name: 'note'; id: string | 'new' }
  | { name: 'global'; tab: GlobalTab }
  | { name: 'search'; q: string }
  | { name: 'project'; project: string; tab: ProjectTab; path?: string }
  | { name: 'notFound' };

export const href = {
  thoughts: () => '#/thoughts',
  thought: (id: string) => `#/thoughts/${id}`,
  notes: () => '#/notes',
  note: (id: string) => `#/notes/${id}`,
  global: (tab: GlobalTab = 'rules') => `#/global${tab === 'rules' ? '' : `/${tab}`}`,
  search: (q = '') => `#/search${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  project: (p: string, tab: ProjectTab = 'state') =>
    `#/p/${encodeURIComponent(p)}${tab === 'state' ? '' : `/${tab}`}`,
  file: (p: string, path: string) => `#/p/${encodeURIComponent(p)}/files?path=${encodeURIComponent(path)}`,
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
  if (!a || a === 'thoughts') return b ? { name: 'thought', id: b } : { name: 'thoughts' };
  if (a === 'notes') return b ? { name: 'note', id: b } : { name: 'notes' };
  if (a === 'global') return { name: 'global', tab: b === 'recall' ? 'recall' : 'rules' };
  if (a === 'search') return { name: 'search', q: params.get('q') ?? '' };
  // Links from earlier versions of the UI.
  if (a === 'memories' && !b) return { name: 'global', tab: 'rules' };
  if (a === 'recall' && !b) return { name: 'global', tab: 'recall' };
  if (a === 'p' && b === 'global') return { name: 'global', tab: c === 'recall' ? 'recall' : 'rules' };
  if (a === 'p' && b) {
    if (!c) return { name: 'project', project: b, tab: 'state' };
    if (c === 'notes') return d ? { name: 'note', id: d } : { name: 'notes' };
    if (c === 'files') return { name: 'project', project: b, tab: 'files', path: params.get('path') ?? undefined };
    if (c === 'state' || c === 'recall' || c === 'setup') return { name: 'project', project: b, tab: c };
  }
  return { name: 'notFound' };
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

import { useEffect, useState } from 'react';

export type ProjectTab = 'memories' | 'recall' | 'setup';
export type Route =
  | { name: 'thoughts' }
  | { name: 'thought'; id: string | 'new' }
  | { name: 'notes' }
  | { name: 'note'; id: string | 'new' }
  | { name: 'memories' }
  | { name: 'search'; q: string }
  | { name: 'project'; project: string; tab: ProjectTab }
  | { name: 'notFound' };

export const href = {
  thoughts: () => '#/thoughts',
  thought: (id: string) => `#/thoughts/${id}`,
  notes: () => '#/notes',
  note: (id: string) => `#/notes/${id}`,
  memories: () => '#/memories',
  search: (q = '') => `#/search${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  project: (p: string, tab: ProjectTab = 'memories') =>
    `#/p/${encodeURIComponent(p)}${tab === 'memories' ? '' : `/${tab}`}`,
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
  if (a === 'memories' && !b) return { name: 'memories' };
  if (a === 'search') return { name: 'search', q: params.get('q') ?? '' };
  // Links from the old UI.
  if (a === 'recall') return { name: 'project', project: 'global', tab: 'recall' };
  if (a === 'p' && b) {
    if (!c) return { name: 'project', project: b, tab: 'memories' };
    // Notes used to belong to projects; they are one notebook now.
    if (c === 'notes') return d ? { name: 'note', id: d } : { name: 'notes' };
    if (c === 'recall' || c === 'setup') return { name: 'project', project: b, tab: c };
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

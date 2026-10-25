import { useEffect, useState } from 'react';

export type Route =
  | { name: 'thoughts' }
  | { name: 'thought'; id: string | 'new' }
  | { name: 'memories' }
  | { name: 'search'; q: string }
  | { name: 'project'; project: string; tab: 'memories' | 'notes' | 'recall' | 'setup' }
  | { name: 'note'; project: string; id: string | 'new' }
  | { name: 'notFound' };

export const href = {
  thoughts: () => '#/thoughts',
  thought: (id: string) => `#/thoughts/${id}`,
  memories: () => '#/memories',
  search: (q = '') => `#/search${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  project: (p: string, tab: 'memories' | 'notes' | 'recall' | 'setup' = 'memories') =>
    `#/p/${encodeURIComponent(p)}${tab === 'memories' ? '' : `/${tab}`}`,
  note: (p: string, id: string) => `#/p/${encodeURIComponent(p)}/notes/${id}`,
};

export function parse(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  const [a, b, c, d] = parts;
  if (!a || a === 'thoughts') return b ? { name: 'thought', id: b } : { name: 'thoughts' };
  if (a === 'memories' && !b) return { name: 'memories' };
  if (a === 'search') return { name: 'search', q: params.get('q') ?? '' };
  // Links from the old UI.
  if (a === 'notes') return { name: 'project', project: 'global', tab: 'notes' };
  if (a === 'recall') return { name: 'project', project: 'global', tab: 'recall' };
  if (a === 'p' && b) {
    if (!c) return { name: 'project', project: b, tab: 'memories' };
    if (c === 'notes' && d) return { name: 'note', project: b, id: d };
    if (c === 'notes' || c === 'recall' || c === 'setup') return { name: 'project', project: b, tab: c };
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

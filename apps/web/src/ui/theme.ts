import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'tabula.theme';
const listeners = new Set<() => void>();

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch { /* storage unavailable */ }
  return 'system';
}

let current: ThemePref = read();

const dark = () =>
  current === 'dark' || (current === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

/** Also run before React in index.html, so the first paint has the right colours. */
export function applyTheme() {
  const root = document.documentElement;
  if (current === 'system') delete root.dataset.theme;
  else root.dataset.theme = current;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark() ? '#0f0e0d' : '#fafaf9');
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  applyTheme();
  listeners.forEach((l) => l());
});

export function setTheme(t: ThemePref) {
  current = t;
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch { /* ignore */ }
  applyTheme();
  listeners.forEach((l) => l());
}

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const t = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  return [t, setTheme];
}

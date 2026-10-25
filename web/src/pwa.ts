import { useSyncExternalStore } from 'react';

/** Chrome/Edge fire this when the app can be installed; Safari never does (Share → Add to Home Screen). */
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function registerPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // show our own button instead of the browser's mini-infobar
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
  // Not in `vite dev`: a service worker there would serve stale modules.
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* installability is optional */ });
    });
  }
}

export async function promptInstall() {
  if (!deferred) return;
  const e = deferred;
  deferred = null;
  emit();
  await e.prompt();
}

/** True while the browser offers installation (and the app isn't already running installed). */
export function useCanInstall(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => deferred !== null,
  );
}

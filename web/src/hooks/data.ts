import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react';
import { addNavigationGuard } from '../router';

/** What changed. Mutations call invalidate(); queries that listen to a topic reload. */
export type Topic = 'projects' | 'memories' | 'notes' | 'thoughts' | 'files';
const subscribers = new Map<Topic, Set<() => void>>();

export function invalidate(...topics: Topic[]) {
  for (const t of topics) subscribers.get(t)?.forEach((fn) => fn());
}

function subscribe(topics: readonly Topic[], fn: () => void) {
  for (const t of topics) {
    if (!subscribers.has(t)) subscribers.set(t, new Set());
    subscribers.get(t)!.add(fn);
  }
  return () => topics.forEach((t) => subscribers.get(t)?.delete(fn));
}

export type Query<T> = { data: T | undefined; error: Error | undefined; loading: boolean; reload: () => void };

/**
 * Fetch on mount and whenever deps change; previous data stays visible while the next page loads
 * (no flicker), stale responses are aborted, and lists refresh when the window regains focus —
 * agents write into Tabula while the UI is open.
 */
export function useQuery<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  opts: { topics?: readonly Topic[]; refetchOnFocus?: boolean; enabled?: boolean } = {},
): Query<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: opts.enabled !== false });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (opts.enabled === false) return;
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    fnRef.current(ac.signal).then(
      (data) => !ac.signal.aborted && setState({ data, loading: false }),
      (error: Error) => !ac.signal.aborted && error.name !== 'AbortError' && setState((s) => ({ ...s, error, loading: false })),
    );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, opts.enabled]);

  const topicsKey = (opts.topics ?? []).join(',');
  useEffect(() => (opts.topics?.length ? subscribe(opts.topics, reload) : undefined), [topicsKey, reload]);

  useEffect(() => {
    if (opts.refetchOnFocus === false) return;
    let last = Date.now();
    const onFocus = () => {
      if (document.visibilityState === 'visible' && Date.now() - last > 5000) {
        last = Date.now();
        reload();
      }
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [opts.refetchOnFocus, reload]);

  return { data: state.data, error: state.error, loading: state.loading, reload };
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Per-viewer conveniences only: storage may be missing (private mode), so every access is guarded. */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : { ...initial, ...JSON.parse(raw) };
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setV(next);
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ }
    },
    [key],
  );
  return [v, set];
}

export type TableState<S extends string, F> = {
  page: number;
  pageSize: number;
  sort: S;
  dir: 'asc' | 'desc';
  filters: F;
};

/**
 * Paging, sort and filters for a server-side table. Sort and page size are remembered per table;
 * any filter or sort change goes back to page 1.
 */
export function useTableState<S extends string, F extends Record<string, unknown>>(
  key: string,
  defaults: { sort: S; dir: 'asc' | 'desc'; pageSize?: number; filters: F },
) {
  const [prefs, setPrefs] = usePersistentState(`tabula.table.${key}`, {
    sort: defaults.sort, dir: defaults.dir, pageSize: defaults.pageSize ?? 25,
  });
  const [page, setPage] = useState(1);
  const [filters, setFiltersState] = useState<F>(defaults.filters);
  return {
    page,
    pageSize: prefs.pageSize,
    sort: prefs.sort,
    dir: prefs.dir,
    filters,
    setPage,
    setPageSize: (pageSize: number) => {
      setPrefs({ ...prefs, pageSize });
      setPage(1);
    },
    setSort: (s: { sort: S; dir: 'asc' | 'desc' }) => {
      setPrefs({ ...prefs, ...s });
      setPage(1);
    },
    setFilter: <K extends keyof F>(k: K, v: F[K]) => {
      setFiltersState((f) => ({ ...f, [k]: v }));
      setPage(1);
    },
    resetFilters: () => {
      setFiltersState(defaults.filters);
      setPage(1);
    },
  };
}

/** Clamp the page when the last row of the last page was deleted. */
export function useClampPage(total: number | undefined, page: number, pageSize: number, setPage: (p: number) => void) {
  useEffect(() => {
    if (total === undefined) return;
    const last = Math.max(1, Math.ceil(total / pageSize));
    if (page > last) setPage(last);
  }, [total, page, pageSize, setPage]);
}

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

/**
 * Ask before navigating away (in-app or closing the tab) while there are unsaved changes.
 * Returns the ref the guard reads: set it to false right before navigating away after a save.
 */
export function useUnsavedGuard(dirty: boolean) {
  const ref = useRef(dirty);
  ref.current = dirty;
  useEffect(() => addNavigationGuard(() => ref.current), []);
  return ref;
}

/** Ctrl/Cmd+S anywhere on the page. */
export function useSaveShortcut(save: () => void, enabled = true) {
  const ref = useRef(save);
  ref.current = save;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

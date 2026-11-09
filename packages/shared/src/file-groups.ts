// Groups project files by folder: the Files tab of the UI and the file list of the recall digest. No imports: @tabula/shared stays dependency-free.

/** Agent work files (specs, plans, progress) live under this folder; their group goes last, collapsed. */
export const WORK_DIR = '.superpowers';
export const ROOT_GROUP = '/';

export type FileGroup<T> = {
  /** The folder shown in the group header: `docs/plans`, `docs`, `/` (root) or `.superpowers`. */
  key: string;
  /** Files with the name to show (the path inside the group's folder), newest first. */
  files: { file: T; name: string }[];
  /** The newest `updatedAt` in the group (ISO). */
  latest: string;
  /** The agent work folder: last in the list and collapsed by default. */
  work: boolean;
};

/**
 * The group of a path: the first two segments of its directory (`docs/plans/a.md` → `docs/plans`,
 * `docs/a.md` → `docs`, `a.md` → `/`); everything under `.superpowers/` is one group.
 */
export function fileGroupKey(path: string): string {
  if (path.startsWith(`${WORK_DIR}/`)) return WORK_DIR;
  const dirs = path.split('/').slice(0, -1);
  return dirs.length ? dirs.slice(0, 2).join('/') : ROOT_GROUP;
}

/** Groups ordered by their most recent change (the work folder last); files inside newest first. */
export function groupFiles<T extends { path: string; updatedAt: string }>(files: readonly T[]): FileGroup<T>[] {
  const byKey = new Map<string, FileGroup<T>>();
  for (const file of files) {
    const key = fileGroupKey(file.path);
    let g = byKey.get(key);
    if (!g) byKey.set(key, (g = { key, files: [], latest: '', work: key === WORK_DIR }));
    g.files.push({ file, name: key === ROOT_GROUP ? file.path : file.path.slice(key.length + 1) });
    if (file.updatedAt > g.latest) g.latest = file.updatedAt;
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.files.sort((a, b) => cmpDesc(a.file.updatedAt, b.file.updatedAt) || cmpAsc(a.name, b.name));
  return groups.sort((a, b) => Number(a.work) - Number(b.work) || cmpDesc(a.latest, b.latest) || cmpAsc(a.key, b.key));
}

const cmpDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
// Plain comparison: localeCompare depends on the locale, so the order could differ between machines.
const cmpAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

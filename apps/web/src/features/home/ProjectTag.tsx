import type { Project } from '../../types';
import { Badge } from '../../ui';

/** A project's name as a small tag; for no project the `none` text (null shows nothing). */
export function ProjectTag({ id, projects, none = 'No project' }: { id: string | null; projects: Project[] | undefined; none?: string | null }) {
  if (!id) return none ? <Badge tone="outline">{none}</Badge> : null;
  return <Badge tone="outline" icon="folder">{projects?.find((p) => p.id === id)?.name || id}</Badge>;
}

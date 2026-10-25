import { MemoriesTable } from '../features/MemoriesTable';
import type { Project } from '../types';

export function MemoriesPage({ projects }: { projects: Project[] | undefined }) {
  return (
    <main className="content content--wide">
      <div className="page-head">
        <div className="page-head__text">
          <h1>All memories</h1>
          <p>Everything agents remember, across projects. The newest is on top, so the last thing an agent wrote is the first thing you review.</p>
        </div>
      </div>
      <MemoriesTable projects={projects} />
    </main>
  );
}

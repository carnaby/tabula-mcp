import { api } from '../api';
import { useQuery } from '../hooks/data';
import { href } from '../router';
import type { ProjectFile } from '../types';
import { Alert, EmptyState, Skeleton } from '../ui';
import { FileContent, TimeAgo } from './common';

export function StatePanel({ project }: { project: string }) {
  const files = useQuery((s) => api.files(project, false, s), [project], { topics: ['files'] });
  if (files.error) return <Alert tone="danger">{files.error.message}</Alert>;
  if (!files.data) return <Skeleton height={320} />;
  const state = files.data.filter((f) => f.isState).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (state.length === 0) {
    return (
      <EmptyState icon="sparkles" title="No project state yet">
        The state is the handoff files that <code className="t-mono">.tabula.json</code> lists under <code className="t-mono">"state"</code> (by default <code className="t-mono">docs/handoff/*.md</code>). They appear here after <code className="t-mono">tabula push</code>.
      </EmptyState>
    );
  }
  return <div className="t-stack">{state.map((f) => <StateFile key={f.path} project={project} file={f} />)}</div>;
}

function StateFile({ project, file }: { project: string; file: ProjectFile }) {
  const content = useQuery((s) => api.file(project, file.path, s), [project, file.path, file.version], { topics: ['files'] });
  return (
    <section className="t-card t-card--pad t-stack">
      <div className="t-row">
        <a className="t-mono" href={href.file(project, file.path)}>{file.path}</a>
        <span className="t-spacer" />
        <span className="t-subtle"><TimeAgo iso={file.updatedAt} /></span>
      </div>
      {content.error && <Alert tone="danger">{content.error.message}</Alert>}
      {content.data ? <FileContent path={file.path} content={content.data.content} /> : !content.error && <Skeleton height={160} />}
    </section>
  );
}

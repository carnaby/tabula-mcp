import { useState } from 'react';
import { api, ApiError } from '../api';
import { invalidate, useQuery } from '../hooks/data';
import { copyText, formatSize } from '../format';
import { backTarget, href, navigate } from '../router';
import { Alert, Badge, Button, EmptyState, IconButton, Skeleton, useConfirm, useToast } from '../ui';
import { AuthorMeta, authorOf, FileContent, TimeAgo } from './common';
import { EditorBar } from './EditorBar';
import { FileHistoryDialog } from './FileHistoryDialog';

export function FileView({
  project, path, from, projects,
}: { project: string; path: string; from?: string; projects?: readonly { id: string; name: string }[] }) {
  const file = useQuery((s) => api.file(project, path, s), [project, path], { topics: ['files'] });
  const [history, setHistory] = useState(false);
  const { confirm } = useConfirm();
  const notify = useToast();
  const back = backTarget(from, href.project(project, 'files'), projects);

  if (file.error) {
    return (
      <EmptyState icon="fileText" title="File not found" action={<Button onClick={() => navigate(back.href)}>{back.label}</Button>}>
        {file.error instanceof ApiError && file.error.status === 404 ? 'It is not in this project.' : file.error.message}
      </EmptyState>
    );
  }
  const f = file.data;

  const toggleDeleted = async () => {
    if (!f) return;
    if (!f.deletedAt && !(await confirm({
      title: 'Delete this file in Tabula?',
      message: 'Copies on disk stay where they are, but clones no longer receive it. You can restore it here.',
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    try {
      if (f.deletedAt) await api.restoreFile(project, f.path);
      else await api.deleteFile(project, f.path);
      invalidate('files', 'projects');
      notify(f.deletedAt ? 'File restored' : 'File deleted');
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  return (
    <div className="t-stack">
      <EditorBar
        back={back}
        meta={
          f ? (
            <AuthorMeta
              author={authorOf(f.updatedBy)}
              iso={f.updatedAt}
              heading="Last changed"
              details={<span className="t-subtle">Version {f.version} · {formatSize(f.size)}</span>}
              onHistory={() => setHistory(true)}
            />
          ) : null
        }
      >
        {f && (
          <>
            <IconButton icon="copy" label="Copy content" onClick={async () => notify((await copyText(f.content)) ? 'Content copied' : 'Copy failed')} />
            <IconButton icon={f.deletedAt ? 'undo' : 'trash'} label={f.deletedAt ? 'Restore' : 'Delete'} onClick={() => void toggleDeleted()} />
          </>
        )}
      </EditorBar>
      <div className="file-view__head">
        <h2 className="file-view__path t-mono">{path}</h2>
        {f?.isState && <Badge tone="accent">state</Badge>}
        {f?.deletedAt && <Badge>deleted</Badge>}
      </div>
      {f?.deletedAt && <Alert tone="warn">Deleted <TimeAgo iso={f.deletedAt} />. Clones no longer receive it; restore it to sync it again.</Alert>}
      {!f ? <Skeleton height={320} /> : (
        <div className="t-card t-card--pad">
          <FileContent path={f.path} content={f.content} />
        </div>
      )}
      {f && <FileHistoryDialog project={project} file={f} open={history} onClose={() => setHistory(false)} />}
    </div>
  );
}

import { useState } from 'react';
import { api, ApiError } from '../api';
import { invalidate, useQuery } from '../hooks/data';
import { copyText, formatSize } from '../format';
import { href, navigate } from '../router';
import { Alert, Badge, Button, EmptyState, IconButton, Skeleton, useConfirm, useToast } from '../ui';
import { FileAuthor, FileContent, TimeAgo } from './common';
import { FileHistoryDialog } from './FileHistoryDialog';

export function FileView({ project, path }: { project: string; path: string }) {
  const file = useQuery((s) => api.file(project, path, s), [project, path], { topics: ['files'] });
  const [history, setHistory] = useState(false);
  const { confirm } = useConfirm();
  const notify = useToast();
  const back = href.project(project, 'files');

  if (file.error) {
    return (
      <EmptyState icon="fileText" title="File not found" action={<Button onClick={() => navigate(back)}>Back to files</Button>}>
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
      <a className="back-link" href={back}>← Files</a>
      <div className="editor__bar">
        <div className="editor__meta">
          <strong className="t-mono">{path}</strong>
          {f && (
            <>
              <span>·</span><span>v{f.version}</span>
              <span>·</span><span>{formatSize(f.size)}</span>
              <span>·</span><FileAuthor by={f.updatedBy} compact />
              <TimeAgo iso={f.updatedAt} />
              {f.isState && <Badge tone="accent">state</Badge>}
              {f.deletedAt && <Badge>deleted</Badge>}
            </>
          )}
        </div>
        <span className="t-spacer" />
        {f && (
          <>
            <IconButton icon="copy" label="Copy content" onClick={async () => notify((await copyText(f.content)) ? 'Content copied' : 'Copy failed')} />
            <IconButton icon="history" label="Version history" onClick={() => setHistory(true)} />
            <IconButton icon={f.deletedAt ? 'undo' : 'trash'} label={f.deletedAt ? 'Restore' : 'Delete'} onClick={() => void toggleDeleted()} />
          </>
        )}
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

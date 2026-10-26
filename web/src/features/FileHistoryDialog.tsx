import { useState } from 'react';
import { api, ApiError } from '../api';
import { invalidate, useQuery } from '../hooks/data';
import { formatSize, fullDate } from '../format';
import type { FileRevision, ProjectFileContent } from '../types';
import { Alert, Button, Dialog, EmptyState, Skeleton, useToast } from '../ui';
import { FileAuthor, FileContent, TimeAgo } from './common';

export function FileHistoryDialog({
  project, file, open, onClose,
}: { project: string; file: ProjectFileContent; open: boolean; onClose: () => void }) {
  const revs = useQuery((s) => api.fileRevisions(project, file.path, s), [project, file.path, file.version], { enabled: open, refetchOnFocus: false });
  const [selected, setSelected] = useState<FileRevision | null>(null);
  const content = useQuery(
    (s) => api.fileRevision(project, file.path, selected!.version, s),
    [project, file.path, selected?.version],
    { enabled: open && !!selected, refetchOnFocus: false },
  );
  const [busy, setBusy] = useState(false);
  const notify = useToast();
  const close = () => {
    setSelected(null);
    onClose();
  };
  const shown = selected && content.data?.version === selected.version ? content.data : null;

  const restore = async () => {
    if (!shown) return;
    setBusy(true);
    try {
      const r = await api.putFile(project, { path: file.path, content: shown.content, base_sha256: file.sha256 });
      invalidate('files', 'projects');
      notify(`Restored v${shown.version} as v${r.version}`);
      close();
    } catch (e) {
      notify(e instanceof ApiError && e.status === 409 ? 'The file changed meanwhile; reopen it and try again.' : (e as Error).message, { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Version history"
      size="lg"
      footer={
        <>
          <Button onClick={close}>Close</Button>
          <Button variant="primary" icon="undo" disabled={!shown} loading={busy} onClick={() => void restore()}>Restore this version</Button>
        </>
      }
    >
      <Alert icon="history">
        Tabula keeps the last 20 previous versions of each file. Restoring writes the old text as a new version; clones get it with <code className="t-mono">tabula pull</code> unless they changed the file too.
      </Alert>
      <div className="revision-list">
        <div className="revision" style={{ cursor: 'default' }}>
          <div className="revision__text">
            <strong>v{file.version} · current</strong>
            <span className="t-subtle"><TimeAgo iso={file.updatedAt} /> · {formatSize(file.size)}</span>
          </div>
          <FileAuthor by={file.updatedBy} />
        </div>
        {!revs.data && <Skeleton height={44} />}
        {revs.data?.length === 0 && <EmptyState icon="history" title="No earlier versions">The file hasn't changed since it was first pushed.</EmptyState>}
        {revs.data?.map((r) => (
          <button key={r.version} type="button" className="revision" aria-pressed={selected?.version === r.version} onClick={() => setSelected(r)}>
            <div className="revision__text">
              <strong>v{r.version}</strong>
              <span className="t-subtle" title={fullDate(r.createdAt)}><TimeAgo iso={r.createdAt} /> · {formatSize(r.size)}</span>
            </div>
            <FileAuthor by={r.updatedBy} />
          </button>
        ))}
      </div>
      {selected && (shown ? (
        <div className="t-card t-card--pad">
          <FileContent path={file.path} content={shown.content} />
        </div>
      ) : <Skeleton height={200} />)}
    </Dialog>
  );
}

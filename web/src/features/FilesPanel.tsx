import { useState } from 'react';
import { api } from '../api';
import { useQuery } from '../hooks/data';
import { formatSize } from '../format';
import { href, navigate } from '../router';
import type { ProjectFile } from '../types';
import { Alert, Badge, type Column, DataTable, EmptyState, SearchInput, Switch } from '../ui';
import { FileAuthor, TimeAgo } from './common';

export function FilesPanel({ project }: { project: string }) {
  const [showDeleted, setShowDeleted] = useState(false);
  const [filter, setFilter] = useState('');
  const files = useQuery((s) => api.files(project, showDeleted, s), [project, showDeleted], { topics: ['files'] });
  const rows = files.data?.filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()));

  const columns: Column<ProjectFile, never>[] = [
    {
      id: 'path', header: 'File', primary: true,
      cell: (f) => (
        <div style={{ minWidth: 0 }}>
          <div className="t-table__primary t-mono">{f.path}</div>
          {(f.isState || f.deletedAt) && (
            <div className="t-row" style={{ gap: 6 }}>
              {f.isState && <Badge tone="accent">state</Badge>}
              {f.deletedAt && <Badge>deleted</Badge>}
            </div>
          )}
        </div>
      ),
    },
    { id: 'size', header: 'Size', width: 100, align: 'right', cell: (f) => <span className="t-subtle t-nowrap">{formatSize(f.size)}</span> },
    { id: 'version', header: 'Version', width: 90, align: 'right', hideOnMobile: true, cell: (f) => <span className="t-subtle">v{f.version}</span> },
    { id: 'by', header: 'By', width: 140, hideOnMobile: true, cell: (f) => <FileAuthor by={f.updatedBy} /> },
    { id: 'updated', header: 'Updated', width: 130, align: 'right', cell: (f) => <span className="t-subtle"><TimeAgo iso={f.updatedAt} /></span> },
  ];

  return (
    <div className="t-stack">
      <div className="toolbar">
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter by path" />
        <span className="t-spacer" />
        <Switch checked={showDeleted} onChange={setShowDeleted} label="Show deleted" />
      </div>
      {files.error && <Alert tone="danger">{files.error.message}</Alert>}
      <DataTable
        label="Files"
        columns={columns}
        rows={rows}
        rowKey={(f) => f.path}
        loading={files.loading}
        onRowClick={(f) => navigate(href.file(project, f.path))}
        rowMuted={(f) => !!f.deletedAt}
        empty={
          <EmptyState icon="fileText" title={filter ? 'No file matches' : 'No synced files yet'}>
            {filter ? 'Try another part of the path.' : <>Add a <code className="t-mono">.tabula.json</code> to the repository (see Setup) and run <code className="t-mono">tabula push</code>.</>}
          </EmptyState>
        }
      />
    </div>
  );
}

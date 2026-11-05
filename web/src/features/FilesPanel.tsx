import { useId, useState } from 'react';
import { api } from '../api';
import { useQuery } from '../hooks/data';
import { formatSize } from '../format';
import { href, navigate } from '../router';
import type { ProjectFile } from '../types';
import { Alert, Badge, type Column, DataTable, EmptyState, Icon, SearchInput, Switch } from '../ui';
import { Author, authorOf, TimeAgo } from './common';
import { type FileGroup, groupFiles, ROOT_GROUP } from '../../../src/shared/file-groups';
import { ListToolbar } from './ListToolbar';

type Row = FileGroup<ProjectFile>['files'][number];

const columns: Column<Row, never>[] = [
  {
    id: 'path', header: 'File', primary: true,
    cell: ({ file: f, name }) => (
      <div style={{ minWidth: 0 }}>
        <div className="t-table__primary t-mono" title={f.path} style={{ overflowWrap: 'anywhere' }}>{name}</div>
        {(f.isState || f.deletedAt) && (
          <div className="t-row" style={{ gap: 6 }}>
            {f.isState && <Badge tone="accent">state</Badge>}
            {f.deletedAt && <Badge>deleted</Badge>}
          </div>
        )}
      </div>
    ),
  },
  { id: 'size', header: 'Size', width: 100, align: 'right', cell: ({ file: f }) => <span className="t-subtle t-nowrap">{formatSize(f.size)}</span> },
  { id: 'version', header: 'Version', width: 90, align: 'right', hideOnMobile: true, cell: ({ file: f }) => <span className="t-subtle">v{f.version}</span> },
  { id: 'by', header: 'By', width: 140, hideOnMobile: true, cell: ({ file: f }) => <Author {...authorOf(f.updatedBy)} /> },
  { id: 'updated', header: 'Updated', width: 130, align: 'right', cell: ({ file: f }) => <span className="t-subtle"><TimeAgo iso={f.updatedAt} /></span> },
];

/** The project's synced files, grouped by folder (the first two levels); the agent work folder last and collapsed. */
export function FilesPanel({ project }: { project: string }) {
  const [showDeleted, setShowDeleted] = useState(false);
  const [filter, setFilter] = useState('');
  const uid = useId();
  // Groups whose open state differs from their default (work folder collapsed, the rest open).
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const files = useQuery((s) => api.files(project, showDeleted, s), [project, showDeleted], { topics: ['files'] });
  const needle = filter.trim().toLowerCase();
  const rows = files.data?.filter((f) => !needle || f.path.toLowerCase().includes(needle));
  const groups = rows && groupFiles(rows);
  const open = (g: FileGroup<ProjectFile>) => !!needle || g.work === toggled.has(g.key);
  const toggle = (key: string) => {
    const next = new Set(toggled);
    if (!next.delete(key)) next.add(key);
    setToggled(next);
  };
  const openFile = (f: Row) => navigate(href.file(project, f.file.path));

  return (
    <div className="t-stack">
      <ListToolbar
        search={<SearchInput value={filter} onChange={setFilter} placeholder="Filter by path" />}
        quick={<Switch checked={showDeleted} onChange={setShowDeleted} label="Show deleted" />}
      />
      {files.error && <Alert tone="danger">{files.error.message}</Alert>}
      {!groups && !files.error && <DataTable label="Files" columns={columns} rows={undefined} rowKey={(f) => f.file.path} />}
      {groups?.length === 0 && (
        <EmptyState icon="fileText" title={filter ? 'No file matches' : 'No synced files yet'}>
          {filter ? 'Try another part of the path.' : <>Add a <code className="t-mono">.tabula.json</code> to the repository (see Setup) and run <code className="t-mono">tabula push</code>.</>}
        </EmptyState>
      )}
      {groups && groups.length > 0 && (
        <div className="file-groups" style={{ opacity: files.loading ? 0.6 : 1 }}>
          {groups.map((g, i) => {
            const expanded = open(g);
            const id = `${uid}-group-${i}`;
            const label = g.key === ROOT_GROUP ? 'Root' : `${g.key}/`;
            const head = (
              <>
                <Icon name="chevronDown" className="t-icon file-group__chevron" />
                <Icon name="folder" />
                <span className="file-group__path t-mono">{g.key === ROOT_GROUP ? '/' : `${g.key}/`}</span>
                <span className="file-group__count">{g.files.length}</span>
                <span className="file-group__latest"><TimeAgo iso={g.latest} /></span>
              </>
            );
            return (
              <section key={g.key} className="file-group" aria-label={`Files in ${label}`}>
                {/* While the path filter has text every group is open, so the header is not a toggle. */}
                {needle ? (
                  <div className="file-group__head">{head}</div>
                ) : (
                  <button type="button" className="file-group__head" aria-expanded={expanded} aria-controls={id} onClick={() => toggle(g.key)}>
                    {head}
                  </button>
                )}
                <div id={id} hidden={!expanded}>
                  <DataTable
                    label={`Files in ${label}`}
                    headless
                    columns={columns}
                    rows={g.files}
                    rowKey={(f) => f.file.path}
                    onRowClick={openFile}
                    rowMuted={(f) => !!f.file.deletedAt}
                  />
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

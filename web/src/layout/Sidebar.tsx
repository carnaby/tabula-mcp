import { useEffect, useState } from 'react';
import { api, clearToken } from '../api';
import { workerAlive } from '../features/reports/Transcript';
import { timeAgo } from '../format';
import { useQuery } from '../hooks/data';
import { promptInstall, useCanInstall } from '../pwa';
import { href, type Route } from '../router';
import type { Project, WorkerStatus } from '../types';
import { Button, Icon, type IconName, IconButton, Input, Kbd, Logo, Segmented, useConfirm, useTheme } from '../ui';

/** A quiet line under Bug reports: is the transcription worker running? Hidden until a worker connected or something waits. */
function WorkerLine({ status }: { status: WorkerStatus | undefined }) {
  if (!status || !status.enabled || (!status.lastSeenAt && !status.queued)) return null;
  const alive = workerAlive(status);
  const seen = alive ? 'Transcription worker online' : status.lastSeenAt ? `Worker last seen ${timeAgo(status.lastSeenAt)}` : 'Worker never connected';
  return (
    <div
      className="worker-line"
      data-alive={alive}
      title={status.queued && !alive ? `${status.queued} recording(s) waiting — run tabula worker --once on your PC` : undefined}
    >
      <span className="worker-line__dot" aria-hidden="true" />
      <span className="t-truncate">{seen}{status.queued ? ` · ${status.queued} waiting` : ''}</span>
    </div>
  );
}

function NavItem({ to, icon, label, count, active }: { to: string; icon: IconName; label: string; count?: number; active: boolean }) {
  return (
    <a className="nav-item" href={to} aria-current={active ? 'page' : undefined}>
      <Icon name={icon} />
      <span className="nav-item__label">{label}</span>
      {count !== undefined && <span className="nav-item__count">{count}</span>}
    </a>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function Sidebar({
  route, projects, onClose, onNewProject,
}: { route: Route; projects: Project[] | undefined; onClose: () => void; onNewProject: () => void }) {
  const [theme, setTheme] = useTheme();
  const canInstall = useCanInstall();
  const reportCounts = useQuery((s) => api.reportCounts(s), [], { topics: ['reports'] });
  const worker = useQuery((s) => api.transcriptionStatus(s), [], { topics: ['reports'] });
  const reloadWorker = worker.reload;
  // "Online" goes stale while the sidebar stays open: look again every minute.
  useEffect(() => {
    const timer = setInterval(reloadWorker, 60_000);
    return () => clearInterval(timer);
  }, [reloadWorker]);
  const openReports = Object.values(reportCounts.data ?? {}).reduce((a, b) => a + b, 0);
  const [filter, setFilter] = useState('');
  const { confirm } = useConfirm();
  const activeProject = route.name === 'project' ? route.project : null;
  const global = projects?.find((p) => p.id === 'global');
  const all = (projects ?? []).filter((p) => p.id !== 'global');
  const f = filter.toLowerCase();
  const shown = all.filter((p) => !f || p.id.includes(f) || p.name.toLowerCase().includes(f));

  return (
    <aside className="sidebar" aria-label="Navigation">
      <div className="sidebar__head">
        <a href={href.thoughts()} aria-label="Tabula home"><Logo /></a>
        <IconButton className="sidebar__close" icon="x" label="Close menu" onClick={onClose} />
      </div>

      <div className="sidebar__scroll">
        <button type="button" className="sidebar__search" onClick={() => { window.location.hash = href.search(); }}>
          <Icon name="search" />
          <span>Search everything</span>
          <Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
        </button>

        <div className="nav-section">Notebook</div>
        <NavItem to={href.thoughts()} icon="lightbulb" label="Thoughts" active={route.name === 'thoughts' || route.name === 'thought'} />
        <NavItem to={href.notes()} icon="fileText" label="Notes" active={route.name === 'notes' || route.name === 'note'} />

        <div className="nav-section">Testing</div>
        <NavItem to={href.reports()} icon="bug" label="Bug reports" count={openReports || undefined} active={route.name === 'reports' || route.name === 'report'} />
        <WorkerLine status={worker.data} />

        <div className="nav-section">For agents</div>
        <NavItem to={href.global()} icon="globe" label="Global" count={global?.memory_count} active={route.name === 'global'} />

        <div className="nav-section">
          <span>Projects</span>
          <IconButton size="sm" icon="plus" label="New project" onClick={onNewProject} />
        </div>
        {all.length > 8 && (
          <div className="nav-filter">
            <Input size_="sm" placeholder="Filter projects" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter projects" />
          </div>
        )}
        {shown.map((p) => (
          <NavItem key={p.id} to={href.project(p.id)} icon="folder" label={p.name || p.id} count={p.file_count} active={activeProject === p.id} />
        ))}
        {!projects && <div className="nav-item t-subtle">Loading…</div>}
      </div>

      {canInstall && (
        <Button icon="download" block onClick={() => void promptInstall()} style={{ marginBottom: 8 }}>
          Install app
        </Button>
      )}
      <div className="sidebar__foot">
        <Segmented
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'system', label: 'System theme', icon: 'monitor', iconOnly: true },
            { value: 'light', label: 'Light theme', icon: 'sun', iconOnly: true },
            { value: 'dark', label: 'Dark theme', icon: 'moon', iconOnly: true },
          ]}
        />
        <IconButton
          icon="logOut"
          label="Sign out (forget token in this browser)"
          onClick={async () => {
            if (await confirm({ title: 'Sign out?', message: 'The token is removed from this browser. You will need it to sign in again.', confirmLabel: 'Sign out' })) {
              clearToken();
              window.location.reload();
            }
          }}
        />
      </div>
    </aside>
  );
}

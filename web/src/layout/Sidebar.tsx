import { useState } from 'react';
import { clearToken } from '../api';
import { promptInstall, useCanInstall } from '../pwa';
import { href, type Route } from '../router';
import type { Project } from '../types';
import { Button, Icon, type IconName, IconButton, Input, Kbd, Logo, Segmented, useConfirm, useTheme } from '../ui';

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
  const [filter, setFilter] = useState('');
  const { confirm } = useConfirm();
  const activeProject = route.name === 'project' || route.name === 'note' ? route.project : null;
  const shown = (projects ?? []).filter(
    (p) => !filter || p.id.includes(filter.toLowerCase()) || p.name.toLowerCase().includes(filter.toLowerCase()),
  );

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

        <div className="nav-section">Agent memory</div>
        <NavItem to={href.memories()} icon="layers" label="All memories" active={route.name === 'memories'} />

        <div className="nav-section">
          <span>Projects</span>
          <IconButton size="sm" icon="plus" label="New project" onClick={onNewProject} />
        </div>
        {(projects?.length ?? 0) > 8 && (
          <div className="nav-filter">
            <Input size_="sm" placeholder="Filter projects" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter projects" />
          </div>
        )}
        {shown.map((p) => (
          <NavItem
            key={p.id}
            to={href.project(p.id)}
            icon={p.id === 'global' ? 'globe' : 'folder'}
            label={p.id === 'global' ? 'Global' : p.name || p.id}
            count={p.memory_count + p.note_count}
            active={activeProject === p.id}
          />
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

import type { ReactNode } from 'react';
import { formatSize, fullDate } from '../../format';
import { href } from '../../router';
import type { DashboardWarning, Project } from '../../types';
import { Icon } from '../../ui';
import { TRIM_LABELS } from '../RecallPanel';

const keyOf = (w: DashboardWarning) => (w.type === 'large_file' ? `${w.type}:${w.id}` : `${w.type}:${w.project ?? ''}`);
const toneOf = (w: DashboardWarning) => (w.type === 'recall_trimmed' && w.steps.includes('state-truncated') ? 'danger' : 'warn');

function body(w: DashboardWarning, name: (id: string) => string): ReactNode {
  switch (w.type) {
    case 'recordings_waiting':
      return (
        <>
          <Icon name="mic" />
          <div className="warning__body">
            <strong>{w.count === 1 ? '1 recording waits' : `${w.count} recordings wait`} for the transcription worker</strong>
            <p>
              The oldest since {fullDate(w.oldest)}. Start the Tabula tray or run <code className="t-mono">tabula worker --once</code> on your PC.
            </p>
          </div>
        </>
      );
    case 'recall_trimmed':
      return (
        <>
          <Icon name="eye" />
          <div className="warning__body">
            <a href={href.project(w.project, 'recall')}>{w.steps.includes('state-truncated') ? 'State is cut off' : 'Recall trimmed'} · {name(w.project)}</a>
            <p>Trimmed to fit the token budget: {w.steps.map((s) => TRIM_LABELS[s] ?? s).join(', ')}.</p>
          </div>
        </>
      );
    case 'large_file':
      return (
        <>
          <Icon name="fileText" />
          <div className="warning__body">
            <a href={href.file(w.project, w.path, href.home())}>{w.path}</a>
            <p>{name(w.project)} · {formatSize(w.size)}, over half of the {formatSize(w.limit)} limit for a file.</p>
          </div>
        </>
      );
  }
}

/** Shown only when something needs a look. */
export function WarningsBlock({ warnings, projects }: { warnings: DashboardWarning[]; projects: Project[] | undefined }) {
  if (!warnings.length) return null;
  const name = (id: string) => projects?.find((p) => p.id === id)?.name || id;
  return (
    <section className="t-card home-block home-block--warnings" aria-labelledby="home-warnings">
      <div className="home-block__head">
        <h2 id="home-warnings">Warnings</h2>
      </div>
      <ul className="warning-list">
        {warnings.map((w) => (
          <li key={keyOf(w)} className="warning" data-tone={toneOf(w)}>{body(w, name)}</li>
        ))}
      </ul>
    </section>
  );
}

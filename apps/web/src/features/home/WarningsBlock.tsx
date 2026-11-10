import { DEFAULT_TIDY_PROMPT, fillTidyPrompt } from '@tabula/shared/tidy-prompt';
import { type ReactNode, useState } from 'react';
import { api } from '../../api';
import { copyText, formatSize, fullDate } from '../../format';
import { useQuery } from '../../hooks/data';
import { href } from '../../router';
import type { DashboardWarning, Project } from '../../types';
import { Button, Icon, IconButton, useToast } from '../../ui';
import { TRIM_LABELS } from '../RecallPanel';
import { PromptDialog } from './PromptDialog';

const keyOf = (w: DashboardWarning) => (w.type === 'large_file' ? `${w.type}:${w.id}` : `${w.type}:${w.project ?? ''}`);
const toneOf = (w: DashboardWarning) => (w.type === 'recall_trimmed' && w.steps.includes('state-truncated') ? 'danger' : 'warn');

function body(w: DashboardWarning, name: (id: string) => string, copy: { disabled: boolean; run: (project: string) => void }): ReactNode {
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
            <Button size="sm" icon="copy" disabled={copy.disabled} aria-label={`Copy tidy prompt: ${name(w.project)}`} onClick={() => copy.run(w.project)}>Copy</Button>
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
  const tidy = useQuery((s) => api.tidyPrompt(s), []);
  const [editing, setEditing] = useState(false);
  const notify = useToast();
  // Until the saved text has loaded there is none: copying or editing the default would be the wrong text.
  const text = tidy.data?.text;
  if (!warnings.length) return null;
  const name = (id: string) => projects?.find((p) => p.id === id)?.name || id;
  const sample = warnings.find((w) => w.type === 'recall_trimmed')?.project ?? 'demo';
  const copy = async (project: string) => {
    if (text === undefined) return;
    const filled = fillTidyPrompt(text, project);
    if (await copyText(filled)) notify('Copied');
    else notify(`Copy failed — the text is: ${filled}`, { tone: 'danger' });
  };
  const actions = { disabled: text === undefined, run: (project: string) => void copy(project) };
  return (
    <section className="t-card home-block home-block--warnings" aria-labelledby="home-warnings">
      <div className="home-block__head">
        <h2 id="home-warnings">Warnings</h2>
        <span className="t-spacer" />
        {tidy.error && !text && <span className="t-subtle">The tidy text did not load.</span>}
        <IconButton size="sm" icon="gear" label="Tidy recall text" disabled={text === undefined} onClick={() => setEditing(true)} />
      </div>
      <ul className="warning-list">
        {warnings.map((w) => (
          <li key={keyOf(w)} className="warning" data-tone={toneOf(w)}>{body(w, name, actions)}</li>
        ))}
      </ul>
      <PromptDialog
        open={editing && text !== undefined}
        title="Tidy recall"
        intro={<>What <strong>Copy</strong> puts on the clipboard for a project whose recall is trimmed: it makes Claude move old content from the project's state files to an archive. <code className="t-mono">{'{project}'}</code> becomes the project; a text without it gets a <code className="t-mono">Project:</code> line at the end.</>}
        text={text ?? ''}
        fallback={DEFAULT_TIDY_PROMPT}
        preview={(clean) => fillTidyPrompt(clean, sample)}
        save={(t) => api.setTidyPrompt(t)}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          tidy.reload();
        }}
      />
    </section>
  );
}

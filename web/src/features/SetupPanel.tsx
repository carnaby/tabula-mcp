import { useEffect, useState } from 'react';
import { api } from '../api';
import { invalidate, useQuery } from '../hooks/data';
import { copyText } from '../format';
import type { Project } from '../types';
import { Alert, Button, Field, Input, Skeleton, useToast } from '../ui';

function CodeBlock({ text, label }: { text: string; label: string }) {
  const notify = useToast();
  return (
    <pre className="t-code-block">
      {text}
      <Button size="sm" icon="copy" onClick={async () => notify((await copyText(text)) ? `${label} copied` : 'Copy failed')}>Copy</Button>
    </pre>
  );
}

export function SetupPanel({ project }: { project: Project | undefined; }) {
  const slug = project?.id ?? '';
  const snippet = useQuery((s) => api.snippet(slug, s), [slug], { enabled: !!slug, refetchOnFocus: false });
  const [draft, setDraft] = useState({ name: '', description: '' });
  const [busy, setBusy] = useState(false);
  const notify = useToast();
  useEffect(() => {
    if (project) setDraft({ name: project.name, description: project.description });
  }, [project?.id, project?.name, project?.description]);
  const dirty = !!project && (draft.name !== project.name || draft.description !== project.description);

  if (!project) return <Skeleton height={240} />;
  const origin = window.location.origin;

  return (
    <div className="t-stack" style={{ gap: 20 }}>
      <section className="t-card t-card--pad t-stack">
        <h3>Project details</h3>
        <div className="editor__grid">
          <Field label="Name">{(id) => <Input id={id} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
          <Field label="Slug" hint="Can't be changed — agents reference it.">{(id) => <Input id={id} className="t-mono" value={project.id} readOnly disabled />}</Field>
        </div>
        <Field label="Description" hint="One sentence; agents see it in list_projects.">
          {(id) => <Input id={id} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}
        </Field>
        <div className="t-row">
          <Button
            variant="primary"
            icon="check"
            disabled={!dirty}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.updateProject(project.id, draft);
                invalidate('projects');
                notify('Project saved');
              } catch (e) {
                notify((e as Error).message, { tone: 'danger' });
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </div>
      </section>

      {project.id === 'global' ? (
        <Alert>Global holds rules and notes that apply to every project; agents get them with every recall, marked <code className="t-mono">[g]</code>.</Alert>
      ) : (
        <section className="t-card t-card--pad t-stack">
          <h3>Connect this project</h3>
          <p className="t-muted">
            Put this section into the repository's <code className="t-mono">CLAUDE.md</code>. Or just tell the agent <em>“use Tabula in this project”</em> — it calls <code className="t-mono">setup_project</code> and adds it itself.
          </p>
          {snippet.data ? <CodeBlock text={snippet.data.text} label="CLAUDE.md section" /> : <Skeleton height={140} />}
          <p className="t-muted">For a claude.ai project, paste the same section into the project instructions.</p>
        </section>
      )}

      <section className="t-card t-card--pad t-stack">
        <h3>Connect a client</h3>
        <p className="t-muted">Once per machine for Claude Code (replace the token):</p>
        <CodeBlock
          label="Command"
          text={`claude mcp add tabula --scope user --transport http ${origin}/mcp \\\n  --header "Authorization: Bearer <TABULA_TOKEN>" \\\n  --header "X-Tabula-Agent: claude-code"`}
        />
        <p className="t-muted">
          In claude.ai: Settings → Connectors → Add custom connector, URL <code className="t-mono">{origin}/mcp/&lt;TABULA_CONNECTOR_SECRET&gt;</code>. Then you can say <em>“save this to Tabula”</em> in any chat and it lands in Thoughts.
        </p>
      </section>
    </div>
  );
}

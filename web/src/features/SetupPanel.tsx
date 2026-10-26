import { useEffect, useState } from 'react';
import { api } from '../api';
import { invalidate, useQuery } from '../hooks/data';
import { copyText } from '../format';
import type { Project } from '../types';
import { Button, Field, Input, Skeleton, useToast } from '../ui';

function CodeBlock({ text, label }: { text: string; label: string }) {
  const notify = useToast();
  return (
    <pre className="t-code-block">
      {text}
      <Button size="sm" icon="copy" onClick={async () => notify((await copyText(text)) ? `${label} copied` : 'Copy failed')}>Copy</Button>
    </pre>
  );
}

const installPosix = (origin: string) => [
  'mkdir -p ~/.tabula',
  `curl -fsSL ${origin}/cli/tabula.mjs -o ~/.tabula/tabula.mjs`,
  'node ~/.tabula/tabula.mjs install',
  `node ~/.tabula/tabula.mjs login ${origin}`,
].join('\n');

const installWindows = (origin: string) => [
  'New-Item -ItemType Directory -Force "$HOME\\.tabula" | Out-Null',
  `Invoke-WebRequest ${origin}/cli/tabula.mjs -OutFile "$HOME\\.tabula\\tabula.mjs"`,
  'node "$HOME\\.tabula\\tabula.mjs" install',
  `node "$HOME\\.tabula\\tabula.mjs" login ${origin}`,
].join('\n');

const HOOK = `{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node ~/.tabula/tabula.mjs pull --hook", "timeout": 10 }] }
    ]
  }
}`;

export function SetupPanel({ project }: { project: Project | undefined }) {
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
          <Field label="Slug" hint="Can't be changed — the repository and agents reference it.">{(id) => <Input id={id} className="t-mono" value={project.id} readOnly disabled />}</Field>
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

      <section className="t-card t-card--pad t-stack">
        <h3>Connect the repository</h3>
        <p className="t-muted">
          Put this section into the repository's <code className="t-mono">CLAUDE.md</code> — or tell the agent <em>“use Tabula in this project”</em>: <code className="t-mono">setup_project</code> returns both blocks.
        </p>
        {snippet.data ? <CodeBlock text={snippet.data.text} label="CLAUDE.md section" /> : <Skeleton height={140} />}
        <p className="t-muted">
          Commit this <code className="t-mono">.tabula.json</code> in the repository root. <code className="t-mono">sync</code> lists the untracked files to keep in Tabula, <code className="t-mono">state</code> the ones that form the current project state. Without <code className="t-mono">"project"</code> the folder name is the slug — add <code className="t-mono">"project": "{project.id}"</code> if the folder is named differently.
        </p>
        {snippet.data ? <CodeBlock text={snippet.data.tabulaJson} label=".tabula.json" /> : <Skeleton height={90} />}
        <p className="t-muted">For a claude.ai project, paste the project instructions template from the repository's <code className="t-mono">templates/</code> folder with this slug.</p>
      </section>

      <section className="t-card t-card--pad t-stack">
        <h3>Install the tabula command</h3>
        <p className="t-muted">Once per machine (Node 22 or newer). macOS and Linux:</p>
        <CodeBlock label="Commands" text={installPosix(origin)} />
        <p className="t-muted">Windows (PowerShell):</p>
        <CodeBlock label="Commands" text={installWindows(origin)} />
        <p className="t-muted">
          <code className="t-mono">install</code> puts <code className="t-mono">tabula</code> and <code className="t-mono">tabula.cmd</code> into <code className="t-mono">~/.tabula/bin</code> and tells you how to add it to PATH. Then run <code className="t-mono">tabula status</code> in the repository before the first <code className="t-mono">tabula push</code>: it lists every file the push would upload, so a too broad <code className="t-mono">sync</code> pattern shows up before anything leaves the machine.
        </p>
      </section>

      <section className="t-card t-card--pad t-stack">
        <h3>Restore files when a session starts</h3>
        <p className="t-muted">
          Once per machine, merge this into <code className="t-mono">~/.claude/settings.json</code>. On Windows use the absolute path that <code className="t-mono">tabula install</code> prints, e.g. <code className="t-mono">node "C:/Users/you/.tabula/tabula.mjs" pull --hook</code>.
        </p>
        <CodeBlock label="Hook" text={HOOK} />
      </section>

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

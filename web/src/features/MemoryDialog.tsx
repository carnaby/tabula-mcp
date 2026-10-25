import { useState } from 'react';
import { api } from '../api';
import { invalidate, useQuery } from '../hooks/data';
import { fullDate, shortId } from '../format';
import { KIND_INFO, KINDS, type Memory, type MemoryKind, type Project } from '../types';
import { Alert, Badge, Button, Counter, Dialog, Field, Input, TagInput, Textarea, useConfirm, useToast, charCount } from '../ui';
import { Author, KindBadge, ProjectSelect } from './common';

export type MemoryDialogState =
  | { mode: 'edit'; memory: Memory }
  | { mode: 'create'; projectId: string; supersedes?: Memory }
  | null;

type Draft = { projectId: string; kind: MemoryKind; title: string; body: string; tags: string[] };

const fromMemory = (m: Memory): Draft => ({ projectId: m.projectId, kind: m.kind, title: m.title, body: m.body, tags: m.tags });

export function MemoryDialog({ state, onClose, projects }: { state: MemoryDialogState; onClose: () => void; projects: Project[] | undefined }) {
  // Keyed so every open starts from fresh state.
  const key = state ? (state.mode === 'edit' ? `e-${state.memory.id}-${state.memory.updatedAt}` : `c-${state.supersedes?.id ?? ''}`) : 'closed';
  return <MemoryDialogInner key={key} state={state} onClose={onClose} projects={projects} />;
}

function MemoryDialogInner({ state, onClose, projects }: { state: MemoryDialogState; onClose: () => void; projects: Project[] | undefined }) {
  const initial: Draft =
    state?.mode === 'edit'
      ? fromMemory(state.memory)
      : state?.supersedes
        ? fromMemory(state.supersedes)
        : { projectId: state?.projectId || 'global', kind: 'rule', title: '', body: '', tags: [] };
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showChain, setShowChain] = useState(false);
  const [replace, setReplace] = useState<MemoryDialogState>(null);
  const { confirm, prompt } = useConfirm();
  const notify = useToast();

  const memory = state?.mode === 'edit' ? state.memory : null;
  const supersedes = state?.mode === 'create' ? state.supersedes : undefined;
  const chain = useQuery((s) => api.chain(memory!.id, s), [memory?.id], { enabled: !!memory && showChain, refetchOnFocus: false });
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const invalid = !draft.title.trim() || !draft.body.trim() || charCount(draft.title.trim()) > 120 || charCount(draft.body.trim()) > 2000;

  const close = async () => {
    if (dirty && !(await confirm({ title: 'Discard changes?', message: 'Your edits to this memory will be lost.', confirmLabel: 'Discard', danger: true }))) return;
    onClose();
  };

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      invalidate('memories');
      notify(done);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    memory
      ? run(() => api.updateMemory(memory.id, { kind: draft.kind, title: draft.title, body: draft.body, tags: draft.tags }), 'Memory saved')
      : run(() => api.createMemory({ ...draft, supersedesId: supersedes?.id ?? null }), supersedes ? 'New version saved; the old one is deprecated' : 'Memory created');

  const title = memory ? 'Edit memory' : supersedes ? 'Replace with a new version' : 'New memory';

  return (
    <>
      <Dialog
        open={!!state && !replace}
        onClose={close}
        title={title}
        size="lg"
        headerExtra={memory && <Badge tone="outline">{shortId(memory.id)}</Badge>}
        footer={
          <>
            {memory && (
              <>
                <Button
                  variant="danger"
                  icon="trash"
                  disabled={busy}
                  onClick={async () => {
                    if (await confirm({ title: 'Delete memory permanently?', message: 'This cannot be undone. Deprecate it instead to keep the history.', confirmLabel: 'Delete', danger: true })) {
                      void run(() => api.deleteMemory(memory.id), 'Memory deleted');
                    }
                  }}
                >
                  Delete
                </Button>
                {memory.status === 'active' && (
                  <Button
                    icon="ban"
                    disabled={busy}
                    onClick={async () => {
                      const reason = await prompt({ title: 'Deprecate memory', label: 'Why is it no longer valid?', placeholder: 'e.g. We moved from Prisma to Drizzle', confirmLabel: 'Deprecate' });
                      if (reason) void run(() => api.deprecateMemory(memory.id, reason), 'Memory deprecated');
                    }}
                  >
                    Deprecate
                  </Button>
                )}
                {memory.status === 'active' && (
                  <Button icon="refresh" disabled={busy} onClick={() => setReplace({ mode: 'create', projectId: memory.projectId, supersedes: memory })}>
                    New version
                  </Button>
                )}
              </>
            )}
            <span className="t-spacer" />
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" icon="check" loading={busy} disabled={invalid || (!!memory && !dirty)} onClick={save}>
              {memory ? 'Save' : 'Create'}
            </Button>
          </>
        }
      >
        {error && <Alert tone="danger">{error}</Alert>}
        {supersedes && (
          <Alert>
            Saving creates a new memory and deprecates <strong>{supersedes.title}</strong> in the same step, so the history stays visible.
          </Alert>
        )}
        {memory?.status === 'deprecated' && (
          <Alert tone="warn" icon="ban">
            Deprecated{memory.deprecatedReason ? `: ${memory.deprecatedReason}` : ''}. Agents no longer see it in recall.
          </Alert>
        )}
        {memory?.source === 'agent' && (
          <Alert icon="bot">Written by agent <strong>{memory.agentLabel ?? 'unknown'}</strong>. Your edits are not marked as human-written; agents can still supersede it.</Alert>
        )}

        {!memory && !supersedes && (
          <Field label="Project">
            {(id) => <ProjectSelect id={id} projects={projects} value={draft.projectId} onChange={(projectId) => setDraft({ ...draft, projectId })} />}
          </Field>
        )}

        <div className="t-field">
          <span className="t-field__label">Kind</span>
          <div className="kind-picker" role="group" aria-label="Kind">
            {KINDS.map((k) => (
              <button key={k} type="button" aria-pressed={draft.kind === k} onClick={() => setDraft({ ...draft, kind: k })}>
                <span><KindBadge kind={k} /></span>
                <span>{KIND_INFO[k].hint}</span>
              </button>
            ))}
          </div>
        </div>

        <Field label="Title" aside={<Counter value={draft.title} max={120} />} hint="One line. Imperative for rules: “Run tests via pnpm test:unit”.">
          {(id) => <Input id={id} autoFocus={!memory} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />}
        </Field>
        <Field label="Body" aside={<Counter value={draft.body} max={2000} />} hint="The why and the context in 1–5 sentences.">
          {(id) => (
            <Textarea
              id={id}
              rows={6}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !invalid) { e.preventDefault(); void save(); }
              }}
            />
          )}
        </Field>
        <Field label="Tags">
          {(id) => <TagInput id={id} value={draft.tags} onChange={(tags) => setDraft({ ...draft, tags })} />}
        </Field>

        {memory && (
          <>
            <dl className="meta-grid">
              <dt>Project</dt><dd>{memory.projectId}</dd>
              <dt>Author</dt><dd><Author source={memory.source} label={memory.agentLabel} /></dd>
              <dt>Created</dt><dd>{fullDate(memory.createdAt)}</dd>
              <dt>Updated</dt><dd>{fullDate(memory.updatedAt)}</dd>
              <dt>Id</dt><dd className="t-mono">{memory.id}</dd>
            </dl>
            {(memory.supersedesId || memory.status === 'deprecated') && (
              <div className="t-stack" style={{ gap: 8 }}>
                <Button size="sm" icon="link" onClick={() => setShowChain(!showChain)} style={{ justifySelf: 'start' }}>
                  {showChain ? 'Hide' : 'Show'} version history
                </Button>
                {showChain && chain.data && (
                  <ol className="chain">
                    {chain.data.map((c) => (
                      <li key={c.id} data-current={c.id === memory.id}>
                        <span className="t-truncate" style={{ flex: 1 }}>{c.title}</span>
                        <Badge tone={c.status === 'active' ? 'success' : 'neutral'}>{c.status}</Badge>
                        <Author source={c.source} label={c.agentLabel} compact />
                        <span className="t-subtle t-nowrap">{new Date(c.createdAt).toLocaleDateString()}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </>
        )}
      </Dialog>
      {replace && <MemoryDialog state={replace} projects={projects} onClose={() => { setReplace(null); onClose(); }} />}
    </>
  );
}

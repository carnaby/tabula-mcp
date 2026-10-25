import { useState } from 'react';
import { api, ApiError } from '../api';
import { TimeAgo } from '../features/common';
import { invalidate, useQuery, useSaveShortcut, useUnsavedGuard } from '../hooks/data';
import { estimateTokens, wordCount } from '../format';
import { href, navigate } from '../router';
import type { Note } from '../types';
import {
  Alert, Badge, Button, charCount, Counter, EmptyState, Field, IconButton, Input, MarkdownEditor, Skeleton, Switch, TagInput,
  useConfirm, useToast,
} from '../ui';

type Draft = { title: string; summary: string; body: string; tags: string[]; pinned: boolean };
const toDraft = (n: Note | null): Draft => ({
  title: n?.title ?? '', summary: n?.summary ?? '', body: n?.body ?? '', tags: n?.tags ?? [], pinned: n?.pinned ?? false,
});

export function NoteEditorPage({ project, id }: { project: string; id: string }) {
  const isNew = id === 'new';
  const loaded = useQuery((s) => api.note(id, s), [id], { enabled: !isNew, refetchOnFocus: false });
  if (!isNew && loaded.error) {
    return (
      <main className="content">
        <EmptyState icon="fileText" title="Note not found" action={<Button onClick={() => navigate(href.project(project, 'notes'))}>Back to notes</Button>}>
          {loaded.error instanceof ApiError && loaded.error.status === 404 ? 'It may have been deleted.' : loaded.error.message}
        </EmptyState>
      </main>
    );
  }
  if (!isNew && !loaded.data) return <main className="content"><Skeleton height={36} width="50%" /><Skeleton height={380} /></main>;
  return <Editor project={project} initial={isNew ? null : loaded.data!} />;
}

function Editor({ project, initial }: { project: string; initial: Note | null }) {
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState(toDraft(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { confirm } = useConfirm();
  const notify = useToast();
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(base));
  const dirtyRef = useUnsavedGuard(dirty);
  const invalid = !draft.title.trim() || charCount(draft.summary.trim()) > 200;
  const back = href.project(project, 'notes');

  const save = async () => {
    if (invalid || saving || (!dirty && base)) return;
    const pinning = draft.pinned && !base?.pinned;
    if (pinning && !(await confirm({
      title: 'Pin this note?',
      message: `A pinned note goes into every recall of “${project}” in full and is never trimmed. This one adds ~${estimateTokens(draft.body)} tokens to a 1 500-token budget.`,
      confirmLabel: 'Pin and save',
    }))) return;
    setSaving(true);
    setError('');
    try {
      const n = base ? await api.updateNote(base.id, draft) : await api.createNote({ ...draft, projectId: project });
      invalidate('notes');
      setBase(n);
      setDraft(toDraft(n));
      notify('Note saved');
      if (n.pinned) {
        const preview = await api.recall(project);
        if (preview.overBudget || preview.tokens > preview.budget) {
          notify(`Recall for “${project}” is now ~${preview.tokens} tokens, over the ${preview.budget} budget. Shorten pinned notes.`, { tone: 'danger' });
        }
      }
      if (!base) {
        dirtyRef.current = false;
        window.location.replace(href.note(project, n.id));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  useSaveShortcut(() => void save());

  return (
    <main className="content">
      <a className="back-link" href={back}>← Notes in {project === 'global' ? 'Global' : project}</a>
      <div className="editor__bar">
        <div className="editor__meta">
          {base ? <>Updated <TimeAgo iso={base.updatedAt} /></> : 'New note'}
          <span>·</span>
          <span>{wordCount(draft.body)} words · ~{estimateTokens(draft.body)} tokens</span>
          {base?.pinned && <Badge tone="accent" icon="pin">pinned</Badge>}
          {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        </div>
        <span className="t-spacer" />
        {base && (
          <IconButton
            icon="trash"
            label="Delete note"
            onClick={async () => {
              if (!(await confirm({ title: 'Delete this note permanently?', message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
              try {
                await api.deleteNote(base.id);
                dirtyRef.current = false;
                setDraft(toDraft(base));
                invalidate('notes');
                notify('Note deleted');
                window.location.replace(back);
              } catch (e) {
                notify((e as Error).message, { tone: 'danger' });
              }
            }}
          />
        )}
        <Button variant="primary" icon="check" loading={saving} disabled={invalid || (!dirty && !!base)} onClick={() => void save()} title="Save (Ctrl/⌘ S)">Save</Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="editor">
        <input
          className="editor__title"
          placeholder="Title"
          aria-label="Title"
          value={draft.title}
          autoFocus={!base}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
        <Field label="Summary" aside={<Counter value={draft.summary} max={200} />} hint="Shown next to the title in every recall digest — tell the agent when to fetch the full note.">
          {(fid) => <Input id={fid} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />}
        </Field>
        <div className="editor__grid">
          <Field label="Tags">{(fid) => <TagInput id={fid} value={draft.tags} onChange={(tags) => setDraft({ ...draft, tags })} />}</Field>
          <div className="t-field" style={{ alignContent: 'end' }}>
            <Switch checked={draft.pinned} onChange={(pinned) => setDraft({ ...draft, pinned })} label={<span>Pinned — included in full in every recall</span>} />
          </div>
        </div>
        <MarkdownEditor value={draft.body} onChange={(body) => setDraft({ ...draft, body })} onSubmit={() => void save()} />
      </div>
    </main>
  );
}

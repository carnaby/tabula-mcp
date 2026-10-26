import { useState } from 'react';
import { api, ApiError } from '../api';
import { TimeAgo } from '../features/common';
import { invalidate, useQuery, useSaveShortcut, useUnsavedGuard } from '../hooks/data';
import { href, navigate } from '../router';
import type { Note } from '../types';
import { Alert, Badge, Button, EmptyState, Field, IconButton, MarkdownEditor, Skeleton, TagInput, useConfirm, useToast } from '../ui';

type Draft = { title: string; body: string; tags: string[] };
const toDraft = (n: Note | null): Draft => ({ title: n?.title ?? '', body: n?.body ?? '', tags: n?.tags ?? [] });
const same = (a: Draft, b: Draft) => a.title === b.title && a.body === b.body && a.tags.join(',') === b.tags.join(',');

export function NoteEditorPage({ id }: { id: string }) {
  const isNew = id === 'new';
  const loaded = useQuery((s) => api.note(id, s), [id], { enabled: !isNew, refetchOnFocus: false });
  if (!isNew && loaded.error) {
    return (
      <main className="content">
        <EmptyState icon="fileText" title="Note not found" action={<Button onClick={() => navigate(href.notes())}>Back to notes</Button>}>
          {loaded.error instanceof ApiError && loaded.error.status === 404 ? 'It may have been deleted.' : loaded.error.message}
        </EmptyState>
      </main>
    );
  }
  if (!isNew && !loaded.data) {
    return (
      <main className="content">
        <Skeleton height={36} width="50%" />
        <Skeleton height={380} />
      </main>
    );
  }
  return <Editor initial={isNew ? null : loaded.data!} />;
}

function Editor({ initial }: { initial: Note | null }) {
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState(toDraft(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { confirm } = useConfirm();
  const notify = useToast();
  const tags = useQuery((s) => api.noteTags(s), [], { refetchOnFocus: false });
  const dirty = !same(draft, toDraft(base));
  const dirtyRef = useUnsavedGuard(dirty);
  const invalid = !draft.title.trim();

  const save = async () => {
    if (invalid || saving || (!dirty && base)) return;
    setSaving(true);
    setError('');
    try {
      const n = base ? await api.updateNote(base.id, draft) : await api.createNote(draft);
      invalidate('notes');
      setBase(n);
      setDraft(toDraft(n));
      notify('Note saved');
      if (!base) {
        dirtyRef.current = false;
        window.location.replace(href.note(n.id));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  useSaveShortcut(() => void save());

  const togglePin = async () => {
    if (!base) return;
    try {
      const n = await api.updateNote(base.id, { pinned: !base.pinned });
      setBase((b) => b && { ...b, pinned: n.pinned });
      invalidate('notes');
      notify(n.pinned ? 'Pinned to the top' : 'Unpinned');
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  const remove = async () => {
    if (!base) return;
    if (!(await confirm({ title: 'Delete this note?', message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.deleteNote(base.id);
      dirtyRef.current = false;
      setDraft(toDraft(base));
      invalidate('notes');
      notify('Note deleted');
      window.location.replace(href.notes());
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  return (
    <main className="content">
      <a className="back-link" href={href.notes()}>← Notes</a>
      <div className="editor__bar">
        <div className="editor__meta">
          {base ? <>Updated <TimeAgo iso={base.updatedAt} /></> : 'New note'}
          {base?.projectId && <Badge tone="outline">{base.projectId}</Badge>}
          {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        </div>
        <span className="t-spacer" />
        {base && (
          <>
            <IconButton icon="pin" label={base.pinned ? 'Unpin' : 'Pin to top'} pressed={base.pinned} onClick={() => void togglePin()} />
            <IconButton icon="trash" label="Delete note" onClick={() => void remove()} />
          </>
        )}
        <Button variant="primary" icon="check" loading={saving} disabled={invalid || (!dirty && !!base)} onClick={() => void save()} title="Save (Ctrl/⌘ S)">
          Save
        </Button>
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
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              document.getElementById('note-body')?.focus();
            }
          }}
        />
        <Field label="Tags">
          {(fid) => <TagInput id={fid} value={draft.tags} onChange={(t) => setDraft({ ...draft, tags: t })} suggestions={tags.data?.map((t) => t.tag)} />}
        </Field>
        <MarkdownEditor
          id="note-body"
          value={draft.body}
          onChange={(body) => setDraft({ ...draft, body })}
          onSubmit={() => void save()}
          placeholder="Write freely. Markdown works: # heading, - list, **bold**, [link](https://…)"
        />
      </div>
    </main>
  );
}

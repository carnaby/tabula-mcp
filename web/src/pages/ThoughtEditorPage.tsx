import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Author, TimeAgo } from '../features/common';
import { HistoryDialog } from '../features/HistoryDialog';
import { invalidate, useQuery, useSaveShortcut, useUnsavedGuard } from '../hooks/data';
import { href, navigate } from '../router';
import type { Thought } from '../types';
import {
  Alert, Badge, Button, charCount, Counter, EmptyState, Field, IconButton, MarkdownEditor, Skeleton, TagInput, useConfirm, useToast,
} from '../ui';

type Draft = { title: string; body: string; tags: string[] };
const toDraft = (t: Thought | null): Draft => ({ title: t?.title ?? '', body: t?.body ?? '', tags: t?.tags ?? [] });
const same = (a: Draft, b: Draft) => a.title === b.title && a.body === b.body && a.tags.join('\u0001') === b.tags.join('\u0001');
const isAgent = (t: Thought) => t.editedBy !== 'human';

export function ThoughtEditorPage({ id }: { id: string }) {
  const isNew = id === 'new';
  const loaded = useQuery((s) => api.thought(id, s), [id], { enabled: !isNew, refetchOnFocus: false });
  if (!isNew && loaded.error) {
    return (
      <main className="content">
        <EmptyState icon="lightbulb" title="Thought not found" action={<Button onClick={() => navigate(href.thoughts())}>Back to Thoughts</Button>}>
          {loaded.error instanceof ApiError && loaded.error.status === 404 ? 'It may have been deleted.' : loaded.error.message}
        </EmptyState>
      </main>
    );
  }
  if (!isNew && !loaded.data) {
    return (
      <main className="content">
        <Skeleton width={120} />
        <Skeleton height={36} width="60%" />
        <Skeleton height={380} />
      </main>
    );
  }
  return <Editor initial={isNew ? null : loaded.data!} />;
}

function Editor({ initial }: { initial: Thought | null }) {
  const [base, setBase] = useState<Thought | null>(initial);
  const [draft, setDraft] = useState<Draft>(toDraft(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /** A newer version exists on the server (an agent edited it, or another tab). */
  const [remote, setRemote] = useState<Thought | null>(null);
  const [conflict, setConflict] = useState(false);
  const [history, setHistory] = useState(false);
  const { confirm } = useConfirm();
  const notify = useToast();
  const tags = useQuery((s) => api.thoughtTags(s), [], { refetchOnFocus: false });

  const dirty = !same(draft, toDraft(base));
  const dirtyRef = useUnsavedGuard(dirty);

  const invalid = !draft.title.trim() || charCount(draft.title.trim()) > 200 || charCount(draft.body) > 50_000;

  const adopt = useCallback((t: Thought) => {
    setBase(t);
    setDraft(toDraft(t));
    setRemote(null);
    setConflict(false);
  }, []);

  // Agents write while the page is open: check for a newer version whenever the tab comes back.
  useEffect(() => {
    if (!base) return;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const latest = await api.thought(base.id);
        if (latest.version === base.version) return;
        if (!dirtyRef.current) {
          adopt(latest);
          notify(`Updated by ${latest.editedBy === 'human' ? 'you in another tab' : latest.editedBy}`);
        } else {
          setRemote(latest);
        }
      } catch { /* offline or deleted; saving will tell */ }
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [base, adopt, notify]);

  const save = async (force = false) => {
    if (invalid || saving || (!dirty && base)) return;
    setSaving(true);
    setError('');
    try {
      if (!base) {
        const t = await api.createThought(draft);
        invalidate('thoughts');
        notify('Thought saved');
        setBase(t);
        dirtyRef.current = false;
        window.location.replace(href.thought(t.id));
        return;
      }
      const t = await api.updateThought(base.id, { ...draft, ...(force ? {} : { expectedVersion: base.version }) });
      adopt(t);
      invalidate('thoughts');
      notify('Saved');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true);
        setRemote(await api.thought(base!.id).catch(() => null));
      } else {
        setError((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  };
  useSaveShortcut(() => void save());

  const toggle = async (patch: { pinned?: boolean; archived?: boolean }, done: string) => {
    if (!base) return;
    try {
      const t = await api.updateThought(base.id, patch);
      setBase((b) => b && { ...b, pinned: t.pinned, archived: t.archived });
      invalidate('thoughts');
      notify(done, patch.archived !== undefined ? { action: { label: 'Undo', run: () => void toggle({ archived: !patch.archived }, patch.archived ? 'Restored' : 'Archived') } } : {});
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  const remove = async () => {
    if (!base) return;
    if (!(await confirm({ title: 'Delete this thought?', message: 'It is deleted with its whole version history. Archive it instead if you might want it back.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.deleteThought(base.id);
      dirtyRef.current = false;
      setDraft(toDraft(base));
      invalidate('thoughts');
      notify('Thought deleted');
      window.location.replace(href.thoughts());
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  return (
    <main className="content">
      <a className="back-link" href={href.thoughts()}>← Thoughts</a>

      <div className="editor__bar">
        <div className="editor__meta">
          {base ? (
            <>
              <Author source={isAgent(base) ? 'agent' : 'human'} label={base.editedBy} />
              <span>·</span>
              <TimeAgo iso={base.updatedAt} />
              <span>·</span>
              <span>v{base.version}</span>
              {base.archived && <Badge icon="archive">archived</Badge>}
            </>
          ) : (
            <span>New thought</span>
          )}
          {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        </div>
        <span className="t-spacer" />
        {base && (
          <>
            <IconButton icon="pin" label={base.pinned ? 'Unpin' : 'Pin to top'} pressed={base.pinned} onClick={() => toggle({ pinned: !base.pinned }, base.pinned ? 'Unpinned' : 'Pinned')} />
            <IconButton icon="history" label="Version history" onClick={() => setHistory(true)} />
            <IconButton icon="archive" label={base.archived ? 'Restore from archive' : 'Archive'} pressed={base.archived} onClick={() => toggle({ archived: !base.archived }, base.archived ? 'Restored from archive' : 'Archived')} />
            <IconButton icon="trash" label="Delete" onClick={remove} />
          </>
        )}
        <Button variant="primary" icon="check" loading={saving} disabled={invalid || (!dirty && !!base)} onClick={() => void save()} title="Save (Ctrl/⌘ S)">
          Save
        </Button>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {remote && (
        <Alert tone="warn">
          <span>
            {conflict ? 'Not saved: ' : ''}
            <strong>{remote.editedBy === 'human' ? 'You (in another tab)' : remote.editedBy}</strong> changed this thought to v{remote.version} while you were editing.
          </span>
          <div className="t-row">
            <Button size="sm" onClick={async () => {
              if (await confirm({ title: 'Load their version?', message: 'Your unsaved edits will be lost. (Their previous text stays in the history.)', confirmLabel: 'Load', danger: true })) adopt(remote);
            }}>
              Load their version
            </Button>
            <Button size="sm" variant="primary" onClick={() => { setBase(remote); setConflict(false); setRemote(null); void save(true); }}>
              Keep mine and save
            </Button>
          </div>
        </Alert>
      )}

      <div className="editor">
        <input
          className="editor__title"
          placeholder="Title"
          aria-label="Title"
          value={draft.title}
          autoFocus={!base}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('thought-body')?.focus(); } }}
        />
        {charCount(draft.title.trim()) > 180 && <Counter value={draft.title} max={200} />}
        <Field label="Tags">
          {(fid) => <TagInput id={fid} value={draft.tags} onChange={(t) => setDraft({ ...draft, tags: t })} suggestions={tags.data?.map((t) => t.tag)} />}
        </Field>
        <MarkdownEditor
          id="thought-body"
          value={draft.body}
          onChange={(body) => setDraft({ ...draft, body })}
          onSubmit={() => void save()}
          placeholder="Write freely. Markdown works: # heading, - list, **bold**, [link](https://…)"
          aside={charCount(draft.body) > 40_000 ? <Counter value={draft.body} max={50_000} /> : undefined}
        />
      </div>

      {base && (
        <HistoryDialog
          thought={base}
          open={history}
          onClose={() => setHistory(false)}
          onRestore={async (r) => {
            if (dirty && !(await confirm({ title: 'Discard your edits?', message: 'Restoring replaces the text you are editing.', confirmLabel: 'Restore', danger: true }))) return;
            try {
              adopt(await api.restoreRevision(base.id, r.id));
              invalidate('thoughts');
              setHistory(false);
              notify(`Restored v${r.version}`);
            } catch (e) {
              notify((e as Error).message, { tone: 'danger' });
            }
          }}
        />
      )}
    </main>
  );
}

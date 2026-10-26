import { useState } from 'react';
import { api } from '../api';
import { invalidate } from '../hooks/data';
import type { Project } from '../types';
import { Button, Dialog, Field, Input, useToast } from '../ui';

const slugify = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function NewProjectDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (p: Project) => void }) {
  const [draft, setDraft] = useState({ id: '', name: '', description: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const notify = useToast();

  const submit = async () => {
    if (!draft.id.trim()) return;
    setBusy(true);
    try {
      const p = await api.createProject(draft);
      invalidate('projects');
      notify(`Project ${p.id} created`);
      setDraft({ id: '', name: '', description: '' });
      setSlugTouched(false);
      setError('');
      onCreated({ ...p, memory_count: 0, file_count: 0 });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!draft.id.trim()} onClick={submit}>Create project</Button>
        </>
      }
    >
      <form className="t-stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Name">
          {(id) => (
            <Input
              id={id}
              autoFocus
              value={draft.name}
              placeholder="Music Creator"
              onChange={(e) => setDraft({ ...draft, name: e.target.value, id: slugTouched ? draft.id : slugify(e.target.value) })}
            />
          )}
        </Field>
        <Field label="Slug" hint="Lowercase letters, digits and dashes — usually the repository folder name. Agents use it in CLAUDE.md." error={error}>
          {(id) => (
            <Input
              id={id}
              className="t-mono"
              value={draft.id}
              placeholder="music-creator"
              aria-invalid={!!error}
              onChange={(e) => { setSlugTouched(true); setDraft({ ...draft, id: e.target.value }); }}
            />
          )}
        </Field>
        <Field label="Description" hint="One sentence; agents see it in list_projects.">
          {(id) => <Input id={id} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

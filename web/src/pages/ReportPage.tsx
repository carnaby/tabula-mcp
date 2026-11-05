import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { AuthorMeta, ProjectSelect } from '../features/common';
import { EditorBar, SaveButton } from '../features/EditorBar';
import { Attachments } from '../features/reports/Attachments';
import { canRecordScreen, canRecordVoice, Recorder } from '../features/reports/Recorder';
import { STATUS_TONE } from '../features/reports/ReportsList';
import { useUploads } from '../features/reports/uploads';
import { invalidate, usePersistentState, useQuery, useSaveShortcut, useUnsavedGuard } from '../hooks/data';
import { backTarget, href, navigate } from '../router';
import { type Attachment, type Project, type Report, REPORT_STATUS_INFO, type ReportStatus } from '../types';
import {
  Alert, Badge, Button, EmptyState, Field, IconButton, Input, Markdown, MarkdownEditor, Segmented, Skeleton, Textarea, useConfirm, useToast,
} from '../ui';

export function ReportPage({
  id, project, from, projects,
}: { id: string; project?: string; from?: string; projects: Project[] | undefined }) {
  const isNew = id === 'new';
  const back = backTarget(from, href.reports());
  const loaded = useQuery((s) => api.report(id, s), [id], { enabled: !isNew, refetchOnFocus: false });
  if (!isNew && loaded.error) {
    return (
      <main className="content">
        <EmptyState icon="bug" title="Report not found" action={<Button onClick={() => navigate(back.href)}>{back.label}</Button>}>
          {loaded.error instanceof ApiError && loaded.error.status === 404 ? 'It may have been deleted.' : loaded.error.message}
        </EmptyState>
      </main>
    );
  }
  if (!isNew && !loaded.data) return <main className="content"><Skeleton height={36} width="50%" /><Skeleton height={240} /></main>;
  const { attachments, ...report } = loaded.data ?? { attachments: [] as Attachment[] };
  return (
    <Editor
      initial={isNew ? null : (report as Report)}
      initialAttachments={attachments}
      defaultProject={project}
      from={from}
      back={back}
      projects={projects?.filter((p) => p.id !== 'global')}
    />
  );
}

type Draft = { projectId: string; title: string; body: string };

function Editor({
  initial, initialAttachments, defaultProject, from, back, projects,
}: {
  initial: Report | null;
  initialAttachments: Attachment[];
  defaultProject?: string;
  from?: string;
  back: { href: string; label: string };
  projects: Project[] | undefined;
}) {
  const [lastProject, setLastProject] = usePersistentState('tabula.report.project', { id: '' });
  const [base, setBase] = useState<Report | null>(initial);
  const [draft, setDraft] = useState<Draft>({
    projectId: initial?.projectId ?? defaultProject ?? lastProject.id ?? '',
    title: initial?.title ?? '',
    body: initial?.body ?? '',
  });
  const [attachments, setAttachments] = useState(initialAttachments);
  const [recording, setRecording] = useState<'voice' | 'screen' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editTriage, setEditTriage] = useState(false);
  const [triageDraft, setTriageDraft] = useState(initial?.triage ?? '');
  const { confirm } = useConfirm();
  const notify = useToast();
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);

  // Once the projects are known, a remembered project that no longer exists is dropped.
  useEffect(() => {
    if (projects && draft.projectId && !projects.some((p) => p.id === draft.projectId)) setDraft((d) => ({ ...d, projectId: '' }));
  }, [projects, draft.projectId]);

  const onUploaded = useCallback((a: Attachment) => {
    setAttachments((list) => [...list, a]);
    invalidate('reports');
  }, []);
  const up = useUploads(onUploaded);
  const worker = useQuery((s) => api.transcriptionStatus(s), [], { topics: ['reports'] });

  // While a recording waits for the worker or is being transcribed, look for its transcript every 10 s.
  const pending = attachments.some((a) => a.transcript?.status === 'queued' || a.transcript?.status === 'running');
  const reloadWorker = worker.reload;
  useEffect(() => {
    if (!base || !pending) return;
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const latest = await api.report(base.id);
        setAttachments((list) =>
          list.map((a) => {
            const fresh = latest.attachments.find((x) => x.id === a.id);
            return fresh ? { ...a, transcript: fresh.transcript, durationMs: fresh.durationMs } : a;
          }),
        );
        reloadWorker();
      } catch { /* offline: the next tick tries again */ }
    }, 10_000);
    return () => clearInterval(timer);
  }, [base, pending, reloadWorker]);

  const textDirty = base
    ? draft.title !== base.title || draft.body !== base.body
    : !!(draft.body.trim() || draft.title.trim());
  const dirty = textDirty || (editTriage && triageDraft !== (base?.triage ?? '')) || up.busy;
  const guard = useUnsavedGuard(dirty);

  /**
   * A new report is created the moment it gets text or a file, so uploads can start right away. One creation at a
   * time: two quick picks (or a pick and a save) must not create two reports.
   */
  const creating = useRef<Promise<Report> | null>(null);
  const ensureReport = (): Promise<Report> => {
    if (base) return Promise.resolve(base);
    if (!draft.projectId) return Promise.reject(new Error('Pick the project first.'));
    creating.current ??= (async () => {
      const r = await api.createReport({ projectId: draft.projectId, title: draft.title.trim() || undefined, body: draft.body });
      setBase(r);
      setDraft((d) => ({ ...d, title: r.title }));
      setLastProject({ id: r.projectId });
      invalidate('reports');
      // Swap the address without remounting: uploads in progress keep going.
      history.replaceState(null, '', href.report(r.id, undefined, from));
      return r;
    })().catch((e: unknown) => {
      creating.current = null; // let the next attempt try again
      throw e;
    });
    return creating.current;
  };

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    try {
      const r = await ensureReport();
      up.add(r.id, files);
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  const save = async (force = false) => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      if (!base) {
        await ensureReport();
        notify('Report saved');
      } else if (textDirty) {
        const r = await api.updateReport(base.id, { title: draft.title, body: draft.body, ...(force ? {} : { expectedVersion: base.version }) });
        setBase(r);
        setDraft((d) => ({ ...d, title: r.title, body: r.body }));
        invalidate('reports');
        notify('Saved');
      }
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? `${e.message}` : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  useSaveShortcut(() => void save());

  // An agent may write the triage while the report is open: reload when the tab comes back, unless you are typing.
  useEffect(() => {
    if (!base) return;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const latest = await api.report(base.id);
        const { attachments: files, ...r } = latest;
        setAttachments(files);
        if (r.version !== base.version && !textDirty && !editTriage) {
          setBase(r);
          setDraft((d) => ({ ...d, title: r.title, body: r.body, projectId: r.projectId }));
          setTriageDraft(r.triage);
          if (r.editedBy !== 'human') notify(`Updated by ${r.editedBy}`);
        }
      } catch { /* offline; the next save will tell */ }
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [base, textDirty, editTriage, notify]);

  const setStatus = async (status: ReportStatus) => {
    if (!base || status === base.status) return;
    if (status === 'done') {
      const media = attachments.filter((a) => (a.kind === 'video' || a.kind === 'audio') && !a.purgedAt).length;
      const ok = await confirm({
        title: 'Close this report?',
        message: media
          ? `Its ${media} video/audio file(s) will be deleted about a day after closing. Photos, saved frames and the text stay. Reopen before then to keep them.`
          : 'You can reopen it later.',
        confirmLabel: 'Close report',
      });
      if (!ok) return;
    }
    try {
      const r = await api.updateReport(base.id, { status });
      setBase(r);
      invalidate('reports');
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  const saveTriage = async () => {
    if (!base) return;
    try {
      const r = await api.updateReport(base.id, { triage: triageDraft, expectedVersion: base.version });
      setBase(r);
      setEditTriage(false);
      invalidate('reports');
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  const remove = async () => {
    if (!base) return;
    if (!(await confirm({ title: 'Delete this report?', message: 'The report and all its files are deleted for good.', confirmLabel: 'Delete', danger: true }))) return;
    await api.deleteReport(base.id);
    guard.current = false;
    invalidate('reports');
    window.location.replace(back.href);
  };

  const closed = base?.status === 'done';

  return (
    <main className="content">
      <EditorBar
        back={back}
        dirty={textDirty}
        meta={
          base ? (
            <AuthorMeta author={{ source: base.editedBy === 'human' ? 'human' : 'agent', label: base.editedBy }} iso={base.updatedAt} />
          ) : (
            <span className="t-truncate">New bug report</span>
          )
        }
      >
        {base && <IconButton icon="trash" label="Delete report" onClick={() => void remove()} />}
        <SaveButton loading={saving} disabled={!!base && !textDirty} onClick={() => void save()} />
      </EditorBar>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="editor">
        <div className="editor__grid">
          <Field label="Project">
            {(fid) =>
              projects && projects.length === 0 ? (
                <Alert>Create a project first — every report belongs to one.</Alert>
              ) : (
                <ProjectSelect
                  id={fid}
                  projects={[{ id: '', name: 'Pick a project…', description: '', memory_count: 0, file_count: 0 }, ...(projects ?? [])]}
                  value={draft.projectId}
                  onChange={async (projectId) => {
                    setDraft({ ...draft, projectId });
                    if (base && projectId) {
                      const r = await api.updateReport(base.id, { projectId });
                      setBase(r);
                      invalidate('reports');
                    }
                  }}
                />
              )
            }
          </Field>
          {base && (
            <Field label="Status">
              {() => (
                <Segmented
                  label="Status"
                  value={base.status}
                  onChange={(s) => void setStatus(s)}
                  options={(['new', 'triaged', 'done'] as const).map((s) => ({ value: s, label: REPORT_STATUS_INFO[s].label }))}
                />
              )}
            </Field>
          )}
        </div>

        <Field label="What's wrong?" hint="Steps, what you expected, what happened. The first line becomes the title if you leave it empty.">
          {(fid) => (
            <Textarea
              id={fid}
              rows={5}
              autoFocus={!base}
              value={draft.body}
              placeholder="e.g. On the song page the play button does nothing after switching tabs…"
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          )}
        </Field>
        {base && (
          <Field label="Title">
            {(fid) => <Input id={fid} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />}
          </Field>
        )}

        <section className="t-stack">
          <div className="section-head">
            <h3>Files</h3>
            <span className="t-subtle">Photos, screen recordings, voice — show it instead of describing it.</span>
          </div>
          {closed ? (
            <Alert>The report is closed; reopen it to add files.</Alert>
          ) : recording ? (
            <Recorder
              mode={recording}
              onCancel={() => setRecording(null)}
              onDone={(file) => {
                setRecording(null);
                void addFiles([file]);
              }}
            />
          ) : (
            <div className="capture-bar">
              <Button icon="camera" onClick={() => camera.current?.click()} disabled={!draft.projectId}>Camera</Button>
              <Button icon="image" onClick={() => gallery.current?.click()} disabled={!draft.projectId}>Photo / video</Button>
              {canRecordVoice() && <Button icon="mic" onClick={() => setRecording('voice')} disabled={!draft.projectId}>Voice</Button>}
              {canRecordScreen() && <Button icon="screen" onClick={() => setRecording('screen')} disabled={!draft.projectId}>Record screen</Button>}
              {!draft.projectId && <span className="t-subtle">Pick a project first.</span>}
            </div>
          )}
          <input ref={camera} type="file" accept="image/*,video/*" capture="environment" hidden onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          <input ref={gallery} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          <Attachments attachments={attachments} uploads={up.uploads} worker={worker.data} onChanged={setAttachments} onDismissUpload={up.dismiss} />
        </section>

        {base && (
          <section className="t-stack">
            <div className="section-head">
              <h3>Triage</h3>
              {base.status !== 'new' && <Badge tone={STATUS_TONE[base.status]}>{REPORT_STATUS_INFO[base.status].label}</Badge>}
              <span className="t-spacer" />
              {!editTriage && <Button size="sm" icon="pencil" onClick={() => { setTriageDraft(base.triage); setEditTriage(true); }}>Edit</Button>}
            </div>
            {editTriage ? (
              <>
                <MarkdownEditor value={triageDraft} onChange={setTriageDraft} minRows={10} onSubmit={() => void saveTriage()} />
                <div className="t-row">
                  <Button onClick={() => setEditTriage(false)}>Cancel</Button>
                  <Button variant="primary" icon="check" onClick={() => void saveTriage()}>Save triage</Button>
                </div>
              </>
            ) : base.triage ? (
              <div className="t-card t-card--pad"><Markdown source={base.triage} /></div>
            ) : (
              <Alert icon="bot">
                No tasks yet. In Claude Code or claude.ai say <em>“process the bug reports for {base.projectId}”</em> — the agent reads the text, looks at the photos and video frames, and writes the analysis and tasks here.
              </Alert>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

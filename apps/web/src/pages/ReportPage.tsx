import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { dateTitle } from '@tabula/shared/report-title';
import { closeReportMessage } from '../features/reports/closeReport';
import { AuthorMeta, authorInfo, authorOf, ProjectSelect } from '../features/common';
import { CopyRefButton } from '../features/CopyRefButton';
import { EditorBar, SaveButton } from '../features/EditorBar';
import { Attachments } from '../features/reports/Attachments';
import { canRecordScreen, canRecordVoice, Recorder } from '../features/reports/Recorder';
import { STATUS_TONE } from '../features/reports/ReportsList';
import { useUploads } from '../features/reports/uploads';
import { invalidate, usePersistentState, useQuery, useSaveShortcut, useUnsavedGuard } from '../hooks/data';
import { backTarget, href, navigate } from '../router';
import { type Attachment, type Project, type Report, REPORT_STATUS_INFO, type ReportStatus } from '../types';
import {
  Alert, Badge, Button, EmptyState, Field, IconButton, Input, Markdown, MarkdownEditor, Segmented, Skeleton, Switch, Textarea, useConfirm, useToast,
} from '../ui';

/** TABULA_MEDIA_PURGE_HOURS until the server has said it (a report not created yet). */
const DEFAULT_PURGE_HOURS = 24;

const isRecording = (a: Attachment) => a.kind === 'video' || a.kind === 'audio';

export function ReportPage({
  id, project, from, attachment, projects,
}: { id: string; project?: string; from?: string; attachment?: string; projects: Project[] | undefined }) {
  const isNew = id === 'new';
  const back = backTarget(from, href.reports(), projects);
  const loaded = useQuery((s) => api.report(id, s), [id], { enabled: !isNew, refetchOnFocus: false });
  if (!isNew && loaded.error) {
    return (
      <main className="content">
        <EmptyState icon="inbox" title="Report not found" action={<Button onClick={() => navigate(back.href)}>{back.label}</Button>}>
          {loaded.error instanceof ApiError && loaded.error.status === 404 ? 'It may have been deleted.' : loaded.error.message}
        </EmptyState>
      </main>
    );
  }
  if (!isNew && !loaded.data) return <main className="content"><Skeleton height={36} width="50%" /><Skeleton height={240} /></main>;
  const { attachments, purgeAfterHours, ...report } = loaded.data ?? { attachments: [] as Attachment[], purgeAfterHours: DEFAULT_PURGE_HOURS };
  return (
    <Editor
      initial={isNew ? null : (report as Report)}
      initialAttachments={attachments}
      purgeAfterHours={purgeAfterHours}
      defaultProject={project}
      from={from}
      back={back}
      focus={attachment}
      projects={projects?.filter((p) => p.id !== 'global')}
    />
  );
}

type Draft = { projectId: string; title: string; body: string };

function Editor({
  initial, initialAttachments, purgeAfterHours, defaultProject, from, back, focus, projects,
}: {
  initial: Report | null;
  initialAttachments: Attachment[];
  /** How long after closing the server deletes video and audio. */
  purgeAfterHours: number;
  defaultProject?: string;
  from?: string;
  back: { href: string; label: string };
  /** The attachment the page was opened on. */
  focus?: string;
  projects: Project[] | undefined;
}) {
  const [lastProject, setLastProject] = usePersistentState('tabula.report.project', { id: '' });
  const [base, setBase] = useState<Report | null>(initial);
  const [draft, setDraft] = useState<Draft>({
    // An existing report shows its own project (or none); a new one starts with the link's or the last used one.
    projectId: initial ? (initial.projectId ?? '') : defaultProject === 'none' ? '' : (defaultProject ?? lastProject.id ?? ''),
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

  // While a recording waits for the worker or is being transcribed (again), look for its transcript every 10 s.
  const pending = attachments.some((a) => {
    const t = a.transcript;
    if (t?.status === 'queued' || t?.status === 'running') return true;
    // A finished transcript being replaced: the page must pick up the new one.
    return t?.status === 'done' && (t.again?.status === 'queued' || t.again?.status === 'running');
  });
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
   * A new report is created the moment it gets text or a file, so uploads can start right away. No field is required:
   * without a project it has none, without a title the server takes the description's first line or the date.
   * One creation at a time: two quick picks (or a pick and a save) must not create two reports.
   */
  const creating = useRef<Promise<Report> | null>(null);
  const ensureReport = (): Promise<Report> => {
    if (base) return Promise.resolve(base);
    creating.current ??= (async () => {
      // Neither title nor description: the browser names it, in the author's local time (Plan decision 2).
      const title = draft.title.trim() || (draft.body.trim() ? undefined : dateTitle(new Date()));
      const r = await api.createReport({ projectId: draft.projectId || null, title, body: draft.body });
      setBase(r);
      setDraft((d) => ({ ...d, title: r.title }));
      setLastProject({ id: r.projectId ?? '' });
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
          setDraft((d) => ({ ...d, title: r.title, body: r.body, projectId: r.projectId ?? '' }));
          setTriageDraft(r.triage);
          if (r.editedBy !== 'human') notify(`Updated by ${authorInfo('agent', r.editedBy).name}`);
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

  /** The project of an existing report changes at once; '' means no project. */
  const changeProject = async (projectId: string) => {
    const before = draft.projectId;
    setDraft((d) => ({ ...d, projectId }));
    try {
      if (!base) {
        // The report is being created with the project chosen before: wait for it, then save the picked one.
        const pending = creating.current;
        if (!pending) return;
        const created = await pending;
        if ((created.projectId ?? '') === projectId) return;
        setBase(await api.updateReport(created.id, { projectId: projectId || null }));
        setLastProject({ id: projectId });
        invalidate('reports');
        return;
      }
      const r = await api.updateReport(base.id, { projectId: projectId || null });
      setBase(r);
      invalidate('reports');
    } catch (e) {
      setDraft((d) => ({ ...d, projectId: before }));
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  const recordings = attachments.filter(isRecording);
  const mediaGone = recordings.length > 0 && recordings.every((a) => a.purgedAt);

  const setKeepMedia = async (keepMedia: boolean) => {
    if (!base) return;
    const graceOver = !!base.closedAt && Date.parse(base.closedAt) + purgeAfterHours * 3600_000 <= Date.now();
    if (!keepMedia && base.status === 'done' && graceOver && recordings.some((a) => !a.purgedAt)) {
      const ok = await confirm({
        title: 'Stop keeping the media?',
        message: 'Video and audio will be deleted within 15 minutes.',
        confirmLabel: 'Stop keeping',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const r = await api.updateReport(base.id, { keepMedia });
      setBase(r);
      invalidate('reports');
    } catch (e) {
      notify((e as Error).message, { tone: 'danger' });
    }
  };

  const setStatus = async (status: ReportStatus) => {
    if (!base || status === base.status) return;
    if (status === 'done') {
      const media = recordings.filter((a) => !a.purgedAt).length;
      const ok = await confirm({
        title: 'Close this report?',
        message: closeReportMessage(media, base.keepMedia, purgeAfterHours),
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
            <AuthorMeta author={authorOf(base.editedBy)} iso={base.updatedAt} />
          ) : (
            <span className="t-truncate">New report</span>
          )
        }
      >
        {base && (
          <>
            <CopyRefButton id={base.id} />
            <IconButton icon="trash" label="Delete report" onClick={() => void remove()} />
          </>
        )}
        <SaveButton loading={saving} disabled={!!base && !textDirty} onClick={() => void save()} />
      </EditorBar>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="editor">
        <Field label="Title">
          {(fid) => (
            <Input
              id={fid}
              value={draft.title}
              placeholder={base ? undefined : 'Optional — the description’s first line, or the date'}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          )}
        </Field>

        <Field label="Description" hint="Steps, what you expected, what happened. The first line becomes the title if you leave it empty.">
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

        <div className="editor__grid">
          <Field label="Project">
            {(fid) => <ProjectSelect id={fid} projects={projects} noProject="" value={draft.projectId} onChange={(v) => void changeProject(v)} />}
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
          {base && (
            <Field label="Media" hint={mediaGone ? 'Media already deleted' : 'Video and audio stay after the report is closed'}>
              {() => <Switch checked={base.keepMedia} disabled={mediaGone} onChange={(v) => void setKeepMedia(v)} label="Keep media" />}
            </Field>
          )}
        </div>

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
              <Button icon="camera" onClick={() => camera.current?.click()}>Camera</Button>
              <Button icon="image" onClick={() => gallery.current?.click()}>Photo / video</Button>
              {canRecordVoice() && <Button icon="mic" onClick={() => setRecording('voice')}>Voice</Button>}
              {canRecordScreen() && <Button icon="screen" onClick={() => setRecording('screen')}>Record screen</Button>}
            </div>
          )}
          <input ref={camera} type="file" accept="image/*,video/*" capture="environment" hidden onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          <input ref={gallery} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          <Attachments attachments={attachments} uploads={up.uploads} worker={worker.data} onChanged={setAttachments} onDismissUpload={up.dismiss} focus={focus} closed={closed} />
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
                No triage yet. In Claude Code or claude.ai say <em>“process the reports{base.projectId ? ` for ${base.projectId}` : ''}”</em> — Claude reads the text and the transcripts, looks at the photos and video frames, and writes the tasks here (for a recording: a summary, the decisions and the tasks).
              </Alert>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

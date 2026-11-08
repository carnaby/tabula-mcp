import type {
  FileRevision, FileRevisionContent, Memory, MemoryKind, MemorySort, Note, NoteSort, Page, Project, RecallPreview, RefTarget, SearchHit, Source, Thought,
  ProjectFile, ProjectFileContent, ThoughtRevision, ThoughtSort,
  Attachment, TranscriptState, WorkerStatus, ReportDetail, Report, ReportSort, ReportStatus, ReportSummary,
} from './types';

const TOKEN_KEY = 'tabula.token';
const storage = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (t: string) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};
export const getToken = storage.get;
export const setToken = storage.set;
export const clearToken = storage.clear;

export class ApiError extends Error {
  /** The error body; e.g. `candidates` of an ambiguous reference. */
  constructor(readonly status: number, message: string, readonly data: Record<string, unknown> = {}) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    signal,
    headers: {
      Authorization: `Bearer ${getToken() ?? ''}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { message?: string; error?: string } & Record<string, unknown>;
    throw new ApiError(res.status, e.message ?? e.error ?? res.statusText, e);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)] as [string, string]);
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};

type Paging<S> = { page?: number; pageSize?: number; sort?: S; dir?: 'asc' | 'desc' };
type MemoryInput = { projectId: string; kind: MemoryKind; title: string; body: string; tags?: string[]; supersedesId?: string | null };
type NoteInput = { title: string; body?: string; tags?: string[]; pinned?: boolean };
type ThoughtInput = { title: string; body?: string; tags?: string[]; pinned?: boolean };
type S = AbortSignal | undefined;

export const api = {
  files: (project: string, deleted: boolean, signal?: S) =>
    request<ProjectFile[]>('GET', `/projects/${encodeURIComponent(project)}/files${qs({ deleted: deleted ? 1 : undefined })}`, undefined, signal),
  file: (project: string, path: string, signal?: S) =>
    request<ProjectFileContent>('GET', `/projects/${encodeURIComponent(project)}/files/content${qs({ path })}`, undefined, signal),
  putFile: (project: string, body: { path: string; content: string; base_sha256: string | null }) =>
    request<{ sha256: string; version: number; changed: boolean }>('PUT', `/projects/${encodeURIComponent(project)}/files`, body),
  deleteFile: (project: string, path: string) =>
    request<{ changed: boolean }>('DELETE', `/projects/${encodeURIComponent(project)}/files${qs({ path })}`),
  restoreFile: (project: string, path: string) =>
    request<{ changed: boolean }>('POST', `/projects/${encodeURIComponent(project)}/files/restore`, { path }),
  fileRevisions: (project: string, path: string, signal?: S) =>
    request<FileRevision[]>('GET', `/projects/${encodeURIComponent(project)}/files/revisions${qs({ path })}`, undefined, signal),
  fileRevision: (project: string, path: string, version: number, signal?: S) =>
    request<FileRevisionContent>('GET', `/projects/${encodeURIComponent(project)}/files/revisions/content${qs({ path, version })}`, undefined, signal),
  projects: (signal?: S) => request<Project[]>('GET', '/projects', undefined, signal),
  createProject: (p: { id: string; name: string; description?: string }) => request<Project>('POST', '/projects', p),
  updateProject: (id: string, p: { name?: string; description?: string }) => request<Project>('PATCH', `/projects/${encodeURIComponent(id)}`, p),
  snippet: (id: string, signal?: S) => request<{ text: string; tabulaJson: string }>('GET', `/projects/${encodeURIComponent(id)}/snippet`, undefined, signal),

  memories: (f: { project?: string; kind?: MemoryKind | ''; status?: string; source?: Source | ''; q?: string } & Paging<MemorySort>, signal?: S) =>
    request<Page<Memory>>('GET', `/memories${qs(f)}`, undefined, signal),
  memory: (id: string, signal?: S) => request<Memory>('GET', `/memories/${id}`, undefined, signal),
  createMemory: (m: MemoryInput) => request<Memory>('POST', '/memories', m),
  updateMemory: (id: string, p: Partial<Omit<MemoryInput, 'projectId' | 'supersedesId'>>) => request<Memory>('PATCH', `/memories/${id}`, p),
  deprecateMemory: (id: string, reason: string) => request<{ changed: boolean }>('POST', `/memories/${id}/deprecate`, { reason }),
  deleteMemory: (id: string) => request<void>('DELETE', `/memories/${id}`),
  chain: (id: string, signal?: S) => request<Memory[]>('GET', `/memories/${id}/chain`, undefined, signal),

  notes: (f: { q?: string; tag?: string } & Paging<NoteSort>, signal?: S) => request<Page<Note>>('GET', `/notes${qs(f)}`, undefined, signal),
  noteTags: (signal?: S) => request<{ tag: string; count: number }[]>('GET', '/notes/tags', undefined, signal),
  note: (id: string, signal?: S) => request<Note>('GET', `/notes/${id}`, undefined, signal),
  createNote: (n: NoteInput) => request<Note>('POST', '/notes', n),
  updateNote: (id: string, p: Partial<NoteInput>) => request<Note>('PATCH', `/notes/${id}`, p),
  deleteNote: (id: string) => request<void>('DELETE', `/notes/${id}`),

  thoughts: (f: { q?: string; tag?: string; archived?: 'true' | 'false' | 'all'; source?: Source | '' } & Paging<ThoughtSort>, signal?: S) =>
    request<Page<Thought>>('GET', `/thoughts${qs(f)}`, undefined, signal),
  thoughtTags: (signal?: S) => request<{ tag: string; count: number }[]>('GET', '/thoughts/tags', undefined, signal),
  thought: (id: string, signal?: S) => request<Thought>('GET', `/thoughts/${id}`, undefined, signal),
  createThought: (t: ThoughtInput) => request<Thought>('POST', '/thoughts', t),
  updateThought: (id: string, p: Partial<ThoughtInput> & { archived?: boolean; expectedVersion?: number }) =>
    request<Thought>('PATCH', `/thoughts/${id}`, p),
  deleteThought: (id: string) => request<void>('DELETE', `/thoughts/${id}`),
  revisions: (id: string, signal?: S) => request<ThoughtRevision[]>('GET', `/thoughts/${id}/revisions`, undefined, signal),
  restoreRevision: (id: string, revId: string) => request<Thought>('POST', `/thoughts/${id}/revisions/${revId}/restore`),

  reports: (f: { project?: string; status?: ReportStatus | 'open' | 'all'; q?: string } & Paging<ReportSort>, signal?: S) =>
    request<Page<ReportSummary>>('GET', `/reports${qs(f)}`, undefined, signal),
  reportCounts: (signal?: S) => request<Record<string, number>>('GET', '/reports/counts', undefined, signal),
  report: (id: string, signal?: S) => request<ReportDetail>('GET', `/reports/${id}`, undefined, signal),
  createReport: (r: { projectId: string; title?: string; body?: string }) => request<Report>('POST', '/reports', r),
  updateReport: (
    id: string,
    p: { title?: string; body?: string; triage?: string; status?: ReportStatus; projectId?: string; expectedVersion?: number },
  ) => request<Report>('PATCH', `/reports/${id}`, p),
  deleteReport: (id: string) => request<void>('DELETE', `/reports/${id}`),
  deleteAttachment: (id: string) => request<void>('DELETE', `/attachments/${id}`),
  saveFrame: (videoId: string, atSeconds: number) => request<Attachment>('POST', `/attachments/${videoId}/frame`, { at: atSeconds }),
  setFrameNote: (id: string, note: string | null) => request<Attachment>('PATCH', `/attachments/${id}`, { note }),
  retryTranscript: (attachmentId: string) => request<TranscriptState>('POST', `/attachments/${attachmentId}/transcript/retry`),
  setSpeakers: (attachmentId: string, names: Record<string, string>) => request<TranscriptState>('PUT', `/attachments/${attachmentId}/speakers`, names),
  speakerNames: (reportId: string, signal?: S) => request<{ names: string[] }>('GET', `/reports/${reportId}/speaker-names`, undefined, signal),
  transcribeAgain: (attachmentId: string) => request<TranscriptState>('POST', `/attachments/${attachmentId}/transcribe`),
  transcriptionStatus: (signal?: S) => request<WorkerStatus>('GET', '/transcription/status', undefined, signal),

  search: (q: string, signal?: S) => request<SearchHit[]>('GET', `/search${qs({ q, limit: 30 })}`, undefined, signal),
  resolve: (ref: string, signal?: S) => request<RefTarget>('GET', `/resolve/${encodeURIComponent(ref)}`, undefined, signal),
  recall: (project: string, signal?: S) => request<RecallPreview>('GET', `/recall/${encodeURIComponent(project)}`, undefined, signal),
};

/**
 * Upload one file as the raw request body. XMLHttpRequest because fetch has no upload progress;
 * abort() cancels it.
 */
export function uploadAttachment(
  reportId: string,
  file: Blob,
  name: string,
  onProgress: (fraction: number) => void,
): { promise: Promise<Attachment>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Attachment>((resolve, reject) => {
    xhr.open('POST', `/api/reports/${reportId}/attachments`);
    xhr.setRequestHeader('Authorization', `Bearer ${getToken() ?? ''}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: { message?: string } & Partial<Attachment> = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 201) resolve(body as Attachment);
      else reject(new ApiError(xhr.status, body.message ?? (xhr.status === 413 ? 'The file is too large' : `Upload failed (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: no connection to Tabula'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

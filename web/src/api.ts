import type {
  Memory, MemoryKind, MemorySort, Note, NoteSort, Page, Project, RecallPreview, SearchHit, Source, Thought,
  ThoughtRevision, ThoughtSort,
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
  constructor(readonly status: number, message: string) {
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
    const e = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(res.status, e.message ?? e.error ?? res.statusText);
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
  projects: (signal?: S) => request<Project[]>('GET', '/projects', undefined, signal),
  createProject: (p: { id: string; name: string; description?: string }) => request<Project>('POST', '/projects', p),
  updateProject: (id: string, p: { name?: string; description?: string }) => request<Project>('PATCH', `/projects/${encodeURIComponent(id)}`, p),
  snippet: (id: string, signal?: S) => request<{ text: string }>('GET', `/projects/${encodeURIComponent(id)}/snippet`, undefined, signal),

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

  search: (q: string, signal?: S) => request<SearchHit[]>('GET', `/search${qs({ q, limit: 30 })}`, undefined, signal),
  recall: (project: string, signal?: S) => request<RecallPreview>('GET', `/recall/${encodeURIComponent(project)}`, undefined, signal),
};

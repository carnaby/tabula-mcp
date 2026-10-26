export type MemoryKind = 'rule' | 'gotcha' | 'decision' | 'fact';
export const KINDS: MemoryKind[] = ['rule', 'gotcha', 'decision', 'fact'];
export const KIND_INFO: Record<MemoryKind, { label: string; hint: string }> = {
  rule: { label: 'Rule', hint: 'How things are done' },
  gotcha: { label: 'Gotcha', hint: 'A trap someone already fell into' },
  decision: { label: 'Decision', hint: 'What was decided and why' },
  fact: { label: 'Fact', hint: "The state of the world the code doesn't show" },
};

export type Source = 'agent' | 'human';

export type Project = { id: string; name: string; description: string; memory_count: number; note_count: number };

export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

export type Memory = {
  id: string;
  projectId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  tags: string[];
  status: 'active' | 'deprecated';
  supersedesId: string | null;
  deprecatedReason: string | null;
  source: Source;
  agentLabel: string | null;
  createdAt: string;
  updatedAt: string;
};
export type MemorySort = 'createdAt' | 'updatedAt' | 'title' | 'kind' | 'projectId' | 'status' | 'source';

export type Note = {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  wordCount: number;
  tokenEstimate: number;
};
export type NoteSort = 'updatedAt' | 'createdAt' | 'title' | 'pinned';

export type Thought = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  source: Source;
  editedBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type ThoughtSort = 'updatedAt' | 'createdAt' | 'title';
export type ThoughtRevision = {
  id: string;
  thoughtId: string;
  version: number;
  title: string;
  body: string;
  tags: string[];
  editedBy: string;
  createdAt: string;
};

export type SearchHit = {
  id: string;
  type: 'memory' | 'note' | 'thought' | 'file';
  project: string | null;
  kind: MemoryKind | null;
  title: string;
  snippet: string;
  status: 'active' | 'deprecated';
  updated_at: string;
};

export type RecallPreview = { text: string; tokens: number; budget: number; trimmed: string[]; overBudget: boolean };

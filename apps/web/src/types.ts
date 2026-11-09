export type MemoryKind = 'rule' | 'gotcha' | 'decision' | 'fact';
export const KINDS: MemoryKind[] = ['rule', 'gotcha', 'decision', 'fact'];
export const KIND_INFO: Record<MemoryKind, { label: string; hint: string }> = {
  rule: { label: 'Rule', hint: 'How things are done' },
  gotcha: { label: 'Gotcha', hint: 'A trap someone already fell into' },
  decision: { label: 'Decision', hint: 'What was decided and why' },
  fact: { label: 'Fact', hint: "The state of the world the code doesn't show" },
};

export type Source = 'agent' | 'human';

export type Project = { id: string; name: string; description: string; memory_count: number; file_count: number; last_activity_at: string };

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
  projectId: string | null;
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
  type: 'memory' | 'note' | 'thought' | 'file' | 'report';
  project: string | null;
  kind: MemoryKind | null;
  title: string;
  snippet: string;
  status: 'active' | 'deprecated';
  updated_at: string;
};

export type RecordType = 'memory' | 'note' | 'thought' | 'report' | 'file' | 'attachment';
/** What a reference points at (GET /api/resolve/:ref). */
export type RefTarget = {
  ref: string; type: RecordType; id: string; project: string | null; title: string;
  kind?: string; report_id?: string; path?: string; status?: string;
};
/** One of the records an ambiguous reference matches; `ref` tells it apart. */
export type RefCandidate = { type: RecordType; id: string; ref: string; title: string };

export type ProjectFile = {
  id: string;
  path: string;
  sha256: string;
  size: number;
  version: number;
  isState: boolean;
  updatedAt: string;
  updatedBy: string;
  deletedAt: string | null;
};
export type ProjectFileContent = ProjectFile & { content: string };
export type FileRevision = { version: number; sha256: string; size: number; updatedBy: string; createdAt: string };
export type FileRevisionContent = FileRevision & { content: string };

export type RecallPreview = { text: string; tokens: number; budget: number; trimmed: string[]; overBudget: boolean };

export type ReportStatus = 'new' | 'triaged' | 'done';
export const REPORT_STATUS_INFO: Record<ReportStatus, { label: string; hint: string }> = {
  new: { label: 'New', hint: 'Captured, waiting for an agent' },
  triaged: { label: 'Triaged', hint: 'An agent wrote the tasks' },
  done: { label: 'Done', hint: 'Fixed and closed' },
};
export type AttachmentKind = 'image' | 'video' | 'audio' | 'frame';
/** A line changed after the worker wrote it: who changed it last, when, and the worker's own text and speaker. */
export type SegmentEdit = { by: 'user' | 'agent'; at: string; original: { text: string; speaker?: string } };
export type TranscriptSegment = { start_ms: number; end_ms: number; text: string; speaker?: string; edit?: SegmentEdit };
/** How the speakers were recognized: the model and how many speak, or why it failed. */
export type Diarization = { model: string; speakers: number } | { error: string };
export type SpeakerName = { name: string; by: 'user' | 'agent'; at: string };
/** A recording transcribed again: its job's state while the old transcript stays on show. */
export type TranscribingAgain = { status: 'queued' | 'running' | 'failed'; error: string | null; retryAt: string | null };
export type TranscriptState =
  | { status: 'none' }
  | { status: 'queued' | 'running' | 'failed'; attempts: number; error: string | null; retryAt: string | null }
  | {
      status: 'done'; language: string | null; model: string; segments: TranscriptSegment[]; createdAt: string;
      diarization: Diarization | null; speakers: Record<string, SpeakerName>; again: TranscribingAgain | null;
    };
/** The transcription worker as the server last saw it; job counts are of open reports. */
export type WorkerStatus = {
  /** False when the server has no TABULA_WORKER_TOKEN: jobs queue, but no worker can connect. */
  enabled: boolean;
  lastSeenAt: string | null;
  workers: { name: string; version: string | null; lastSeenAt: string }[];
  queued: number;
  running: number;
  failed: number;
};
export type Attachment = {
  id: string;
  reportId: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  fileName: string;
  durationMs: number | null;
  sourceId: string | null;
  atMs: number | null;
  /** Frames: the user's note. */
  note: string | null;
  createdBy: string;
  createdAt: string;
  purgedAt: string | null;
  /** Signed link, null once the file was deleted. */
  url: string | null;
  /** Video and audio: the transcript or its state; null (or absent) for photos and frames. */
  transcript?: TranscriptState | null;
};
export type Report = {
  id: string;
  /** null: the report belongs to no project. */
  projectId: string | null;
  title: string;
  body: string;
  triage: string;
  status: ReportStatus;
  source: Source;
  editedBy: string;
  version: number;
  closedAt: string | null;
  /** Video and audio stay after the report is closed. */
  keepMedia: boolean;
  createdAt: string;
  updatedAt: string;
};
export type ReportSummary = Report & { counts: Record<AttachmentKind, number> };
/** `purgeAfterHours`: how long after closing the server deletes video and audio (unless Keep media is on). */
export type ReportDetail = Report & { attachments: Attachment[]; purgeAfterHours: number };
export type ReportSort = 'createdAt' | 'updatedAt' | 'title' | 'status';

/** How the recordings of a waiting report stand, taken together. */
export type WaitingTranscript = 'running' | 'queued' | 'failed' | 'done';
/** Something that waits for the user on Home (GET /api/dashboard), oldest first. */
export type WaitingItem = {
  type: 'new_report' | 'triaged' | 'transcription_failed';
  /** The report. */
  id: string;
  ref: string;
  title: string;
  project: string | null;
  since: string;
  /** For Mark done (expectedVersion). */
  version: number;
  keep_media: boolean;
  /** Video and audio still on disk: the close confirmation names them. */
  recordings: number;
  transcript: WaitingTranscript | null;
  /** transcription_failed: the recording, its file name and the error. */
  attachment_id?: string;
  file_name?: string;
  error?: string | null;
};
export type TrimStep = 'files-collapsed' | 'facts-omitted' | 'gotchas-first-sentence' | 'rules-first-sentence' | 'state-truncated';
export type DashboardWarning =
  | { type: 'recall_trimmed'; project: string; steps: TrimStep[]; tokens: number }
  | { type: 'large_file'; project: string; id: string; ref: string; path: string; size: number; limit: number }
  | { type: 'recordings_waiting'; project: null; count: number; oldest: string };
export type DashboardProject = {
  id: string; name: string; last_activity_at: string; file_count: number; open_reports: number; recall_tokens: number;
};
export type Dashboard = {
  waiting: WaitingItem[];
  warnings: DashboardWarning[];
  projects: DashboardProject[];
  recall_budget: number;
  /** TABULA_MEDIA_PURGE_HOURS, for the Mark done confirmation. */
  purge_after_hours: number;
};

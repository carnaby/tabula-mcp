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
  agentModel: string | null;
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
  editedByModel: string | null;
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
  editedByModel: string | null;
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

export type RecordType = 'memory' | 'note' | 'thought' | 'report' | 'file' | 'attachment' | 'message';
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
  updatedByModel: string | null;
  deletedAt: string | null;
};
export type ProjectFileContent = ProjectFile & { content: string };
export type FileRevision = { version: number; sha256: string; size: number; updatedBy: string; updatedByModel: string | null; createdAt: string };
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
/** How far Fornax is with a running job: a whole percent 0–100 and what it does now (null when it does not say). */
export type TranscriptProgress = { progress?: number | null; progressMessage?: string | null };
/** A recording transcribed again: its job's state while the old transcript stays on show. */
export type TranscribingAgain = { status: 'queued' | 'running' | 'failed'; error: string | null; retryAt: string | null; note?: string | null } & TranscriptProgress;
export type TranscriptState =
  | { status: 'none' }
  | ({ status: 'queued' | 'running' | 'failed'; attempts: number; error: string | null; retryAt: string | null; note?: string | null } & TranscriptProgress)
  | {
      status: 'done'; language: string | null; model: string; segments: TranscriptSegment[]; createdAt: string;
      diarization: Diarization | null; speakers: Record<string, SpeakerName>; again: TranscribingAgain | null;
    };
/** The Fornax worker as Fornax reports it; job counts are of open reports. */
export type WorkerStatus = {
  /** False when the server has no TABULA_FORNAX_URL: recordings are not transcribed. */
  enabled: boolean;
  /** Whether the Fornax worker is online; null when Fornax cannot be reached. */
  online: boolean | null;
  /** Whether the worker offers the transcribe job; null when unknown. */
  offered: boolean | null;
  /** Fornax's address, null when disabled. */
  url: string | null;
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
  createdByModel: string | null;
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
  editedByModel: string | null;
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
  type: 'new_report' | 'triaged' | 'transcription_failed' | 'message_waiting';
  /** The report or message. */
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
  /** message_waiting: the project that declares it sent the message. */
  from?: string;
};
export type TrimStep = 'files-collapsed' | 'facts-omitted' | 'gotchas-first-sentence' | 'rules-first-sentence' | 'state-truncated';
export type DashboardWarning =
  | { type: 'recall_trimmed'; project: string; steps: TrimStep[]; tokens: number }
  | { type: 'large_file'; project: string; id: string; ref: string; path: string; size: number; limit: number }
  | { type: 'recordings_waiting'; project: null; count: number; oldest: string };
export type DashboardProject = {
  id: string; name: string; last_activity_at: string; file_count: number; open_reports: number; recall_tokens: number;
  /** Changes per local day over the last 14 days, oldest first, today last. */
  activity: number[];
};
export type Dashboard = {
  waiting: WaitingItem[];
  warnings: DashboardWarning[];
  projects: DashboardProject[];
  recall_budget: number;
  /** False when the server has no Fornax configured: recordings stay queued by design. */
  transcription_enabled: boolean;
  /** TABULA_MEDIA_PURGE_HOURS, for the Mark done confirmation. */
  purge_after_hours: number;
};

export type ActivityType = 'files' | 'reports' | 'thoughts' | 'notes';
export type ActivityChild = { id: string; path: string; ref: string };
/** One row of the Home timeline (GET /api/activity). */
export type ActivityItem = {
  type: 'file' | 'report' | 'thought' | 'note';
  /** "Pushed 12 files", "New report", "Triage written", "Transcribed", "Saved thought", "Edited note", … */
  action: string;
  ref: string;
  /** The record to open: the file (the newest of a batch), report, thought or note. */
  id: string;
  title: string;
  project: string | null;
  /** 'human', 'cli', an agent's label, or 'worker'. */
  by: string;
  /** The model the writer named (as stated); absent when none. */
  model?: string;
  at: string;
  count?: number;
  /** One file: its path. */
  path?: string;
  /** "Transcribed": the recording. */
  attachment_id?: string;
  /** A batch of two or more files, newest first. */
  children?: ActivityChild[];
};
export type ActivityDay = { date: string; items: ActivityItem[] };
export type ActivityPage = { days: ActivityDay[]; next_before: string | null };

export type MessageType = 'request' | 'report';
export type MessageStatus = 'new' | 'in_progress' | 'waiting' | 'done' | 'rejected';
export type MessageWaitingOn = 'author' | 'sender';
export type MessageStatusFilter = MessageStatus | 'open' | 'archive' | 'all';
export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  new: 'New', in_progress: 'In progress', waiting: 'Waiting', done: 'Done', rejected: 'Rejected',
};
export const MESSAGE_WAITING_LABEL: Record<MessageWaitingOn, string> = { author: 'you', sender: 'the sender' };
export type MessageSummary = {
  id: string; ref: string; to: string; from: string; type: MessageType; title: string; status: MessageStatus;
  waiting_on: MessageWaitingOn | null; related_to: string | null; version: number; created_at: string; updated_at: string;
};
export type MessageEvent = {
  at: string; actor: string; model: string | null; source: Source; version: number; from_status: MessageStatus | null; to_status: MessageStatus | null;
  waiting_on: MessageWaitingOn | null; reply: string | null;
};
export type MessageDetail = MessageSummary & { body: string; source: Source; created_by: string; closed_at: string | null; events: MessageEvent[] };
export type MessageCounts = { open: number; waiting_author: number };
export type MessageToken = { id: string; project: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null };
export type MessagePatch = { expected_version: number; reply?: string; status?: MessageStatus; waiting_on?: MessageWaitingOn };

export type SecurityOverview = {
  via: 'session' | 'legacy';
  fresh: boolean;
  publicUrl: string | null;
  passkeys: Array<{ id: string; name: string; createdAt: string; lastUsedAt: string | null }>;
  connections: Array<{ id: string; name: string; app: string; target: string; resource: 'mcp' | 'api'; createdAt: string; lastUsedAt: string | null }>;
  sessions: Array<{ id: string; device: string; createdAt: string; lastUsedAt: string; current: boolean }>;
  legacy: { since: string | null; token: string | null; connector: string | null; connectorConfigured: boolean };
};

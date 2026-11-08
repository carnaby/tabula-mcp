import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const memoryKind = pgEnum('memory_kind', ['rule', 'decision', 'fact', 'gotcha']);
export const memoryStatus = pgEnum('memory_status', ['active', 'deprecated']);
export const memorySource = pgEnum('memory_source', ['agent', 'human']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    kind: memoryKind('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    status: memoryStatus('status').notNull().default('active'),
    supersedesId: uuid('supersedes_id').references((): AnyPgColumn => memories.id, { onDelete: 'set null' }),
    deprecatedReason: text('deprecated_reason'),
    source: memorySource('source').notNull(),
    agentLabel: text('agent_label'),
    ...timestamps,
    search: tsvector('search').generatedAlwaysAs(
      sql`setweight(to_tsvector('tabula'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('tabula'::regconfig, tabula_tags_text(tags)), 'B') || setweight(to_tsvector('tabula'::regconfig, coalesce(body, '')), 'C')`,
    ),
  },
  (t) => [
    index('memories_search_idx').using('gin', t.search),
    index('memories_project_status_idx').on(t.projectId, t.status),
    check('memories_title_len', sql`char_length(${t.title}) between 1 and 120`),
    check('memories_body_len', sql`char_length(${t.body}) between 1 and 2000`),
  ],
);

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    body: text('body').notNull().default(''),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    pinned: boolean('pinned').notNull().default(false),
    ...timestamps,
    search: tsvector('search').generatedAlwaysAs(
      sql`setweight(to_tsvector('tabula'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('tabula'::regconfig, tabula_tags_text(tags)), 'B') || setweight(to_tsvector('tabula'::regconfig, coalesce(summary, '') || ' ' || coalesce(body, '')), 'C')`,
    ),
  },
  (t) => [
    index('notes_search_idx').using('gin', t.search),
    index('notes_project_idx').on(t.projectId),
    check('notes_summary_len', sql`char_length(${t.summary}) <= 200`),
  ],
);

/**
 * Thoughts: a personal notebook outside projects. Written by the human or, on the user's request, by an agent
 * (e.g. "save this to Tabula" in a claude.ai chat). Never part of the recall digest.
 */
export const thoughts = pgTable(
  'thoughts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    pinned: boolean('pinned').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    source: memorySource('source').notNull(),
    /** Who wrote the current version: 'human' or the agent label. */
    editedBy: text('edited_by').notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps,
    search: tsvector('search').generatedAlwaysAs(
      sql`setweight(to_tsvector('tabula'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('tabula'::regconfig, tabula_tags_text(tags)), 'B') || setweight(to_tsvector('tabula'::regconfig, coalesce(body, '')), 'C')`,
    ),
  },
  (t) => [
    index('thoughts_search_idx').using('gin', t.search),
    index('thoughts_updated_idx').on(t.archived, t.updatedAt),
    check('thoughts_title_len', sql`char_length(${t.title}) between 1 and 200`),
    check('thoughts_body_len', sql`char_length(${t.body}) <= 50000`),
  ],
);

/** The previous versions of a thought, so an agent's edit can always be undone. */
export const thoughtRevisions = pgTable(
  'thought_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    thoughtId: uuid('thought_id')
      .notNull()
      .references(() => thoughts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    editedBy: text('edited_by').notNull(),
    /** When this version was written (= updated_at of the thought at that time). */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('thought_revisions_thought_idx').on(t.thoughtId, t.version)],
);

/**
 * Untracked files of a project's repository (handoff state, private specs and plans), synced by the tabula CLI.
 * One row per path; the previous versions live in project_file_revisions.
 */
export const projectFiles = pgTable(
  'project_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    /** Relative POSIX path from the repository root. */
    path: text('path').notNull(),
    content: text('content').notNull(),
    /** Lowercase hex SHA-256 of the UTF-8 bytes of content. */
    sha256: text('sha256').notNull(),
    /** Size of content in UTF-8 bytes. */
    size: integer('size').notNull(),
    version: integer('version').notNull().default(1),
    /** Who wrote the current version: 'human' (the UI) or an agent label such as 'cli'. */
    updatedBy: text('updated_by').notNull(),
    /** Set by the CLI after each push: the path matches a "state" pattern of the repository's .tabula.json. */
    isState: boolean('is_state').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
    // Path separators become spaces so "handoff" finds docs/handoff/state.md (Postgres would parse the
    // whole path as one token); content is indexed up to 100 000 characters because a tsvector may not exceed 1 MB.
    search: tsvector('search').generatedAlwaysAs(
      sql`setweight(to_tsvector('tabula'::regconfig, translate(coalesce(path, ''), '/._-', '    ')), 'A') || setweight(to_tsvector('tabula'::regconfig, left(coalesce(content, ''), 100000)), 'C')`,
    ),
  },
  (t) => [
    uniqueIndex('project_files_project_path_idx').on(t.projectId, t.path),
    index('project_files_search_idx').using('gin', t.search),
    check('project_files_path_len', sql`char_length(${t.path}) between 1 and 512`),
    check('project_files_size', sql`${t.size} between 0 and 1048576`),
  ],
);

/** Previous versions of a project file (the last 20 are kept). */
export const projectFileRevisions = pgTable(
  'project_file_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => projectFiles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    sha256: text('sha256').notNull(),
    size: integer('size').notNull(),
    updatedBy: text('updated_by').notNull(),
    /** When this version was written (= updated_at of the file at that time). */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('project_file_revisions_file_idx').on(t.fileId, t.version)],
);

/** The "sync" and "state" patterns of the repository's .tabula.json, sent by the CLI on every push. */
export const projectSyncConfigs = pgTable('project_sync_configs', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  sync: text('sync').array().notNull(),
  state: text('state').array().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const reportStatus = pgEnum('report_status', ['new', 'triaged', 'done']);
export const attachmentKind = pgEnum('attachment_kind', ['image', 'video', 'audio', 'frame']);

/**
 * Bug reports: captured on the phone (text, photos, screen recordings, voice), always for one project.
 * The human writes the description; an agent writes the triage (analysis and tasks).
 */
export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** Written by an agent: what is wrong and the tasks to fix it (Markdown). */
    triage: text('triage').notNull().default(''),
    status: reportStatus('status').notNull().default('new'),
    source: memorySource('source').notNull(),
    /** Who wrote the current version: 'human' or the agent label. */
    editedBy: text('edited_by').notNull(),
    version: integer('version').notNull().default(1),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...timestamps,
    search: tsvector('search').generatedAlwaysAs(
      sql`setweight(to_tsvector('tabula'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('tabula'::regconfig, coalesce(body, '') || ' ' || coalesce(triage, '')), 'C')`,
    ),
  },
  (t) => [
    index('reports_search_idx').using('gin', t.search),
    index('reports_project_status_idx').on(t.projectId, t.status),
    check('reports_title_len', sql`char_length(${t.title}) between 1 and 200`),
    check('reports_body_len', sql`char_length(${t.body}) <= 20000`),
    check('reports_triage_len', sql`char_length(${t.triage}) <= 50000`),
  ],
);

/** Files of a report. The bytes live in the media directory under storage_key; the database keeps only metadata. */
export const reportAttachments = pgTable(
  'report_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    kind: attachmentKind('kind').notNull(),
    /** Detected from the file's bytes, not taken from the upload. */
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    fileName: text('file_name').notNull(),
    storageKey: text('storage_key').notNull(),
    durationMs: integer('duration_ms'),
    /** Frames: the video they were taken from and the moment. */
    sourceId: uuid('source_id').references((): AnyPgColumn => reportAttachments.id, { onDelete: 'set null' }),
    atMs: integer('at_ms'),
    /** Frames: what the user wants to say about the moment, which the video does not (max 2 000 characters). */
    note: text('note'),
    createdBy: text('created_by').notNull(),
    /** Set when the bytes were deleted (video and audio after the report is closed); the row stays as a record. */
    purgedAt: timestamp('purged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('report_attachments_report_idx').on(t.reportId, t.createdAt),
    uniqueIndex('report_attachments_storage_key_idx').on(t.storageKey),
    // One saved frame per moment of a video (concurrent requests for the same moment end up with one).
    uniqueIndex('report_attachments_frame_idx').on(t.sourceId, t.atMs),
  ],
);

export const jobStatus = pgEnum('job_status', ['queued', 'running', 'done', 'failed']);
export const jobKind = pgEnum('job_kind', ['transcribe']);

/** One line of a transcript; times in milliseconds from the start of the recording; `speaker` "S1"… when diarized. */
export type TranscriptSegment = { start_ms: number; end_ms: number; text: string; speaker?: string };

/** How the speakers were recognized: the model and how many speak, or why it failed. */
export type Diarization = { model: string; speakers: number } | { error: string };

/** A speaker's name, given by the user or by an agent, and when (for "most recently used" suggestions). */
export type SpeakerName = { name: string; by: 'user' | 'agent'; at: string };
export type SpeakerNames = Record<string, SpeakerName>;

/**
 * Work for the transcription worker, a PC that pulls jobs over HTTPS (Tabula never connects to it). A worker holds a
 * job under a lease and extends it with heartbeats; a lease that runs out puts the job back in the queue.
 */
export const reportJobs = pgTable(
  'report_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => reportAttachments.id, { onDelete: 'cascade' }),
    kind: jobKind('kind').notNull().default('transcribe'),
    status: jobStatus('status').notNull().default('queued'),
    /** How many times a worker took the job; a lease that ran out counts as well. */
    attempts: integer('attempts').notNull().default(0),
    /** Not handed out before this moment (the back-off after a failed attempt). */
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    /** New with every claim: proves that the worker reporting on the job is the one holding it. */
    leaseId: uuid('lease_id'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    /** The worker that took it last (its host name). */
    worker: text('worker'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('report_jobs_attachment_kind_idx').on(t.attachmentId, t.kind),
    index('report_jobs_queue_idx').on(t.status, t.runAfter),
  ],
);

/** Transcripts of video and audio. They stay when the recording is deleted after the report closes: small and worth keeping. */
export const reportTranscripts = pgTable(
  'report_transcripts',
  {
    attachmentId: uuid('attachment_id')
      .primaryKey()
      .references(() => reportAttachments.id, { onDelete: 'cascade' }),
    language: text('language'),
    model: text('model').notNull(),
    /** The segments' text, one per line: what full-text search reads. */
    text: text('text').notNull(),
    segments: jsonb('segments').$type<TranscriptSegment[]>().notNull(),
    /** null: the worker has no speaker recognition (or the transcript came before it). */
    diarization: jsonb('diarization').$type<Diarization>(),
    /** Names of S1, S2 …; a new transcript clears them (a new run may number the speakers differently). */
    speakers: jsonb('speakers').$type<SpeakerNames>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    search: tsvector('search').generatedAlwaysAs(sql`to_tsvector('tabula'::regconfig, left("text", 100000))`),
  },
  (t) => [index('report_transcripts_search_idx').using('gin', t.search)],
);

/** When each transcription worker last called in, for the UI's "worker last seen". */
export const workers = pgTable('workers', {
  name: text('name').primaryKey(),
  version: text('version'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

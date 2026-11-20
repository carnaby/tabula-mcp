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
    /** The model the agent named itself (normalized); null for the UI and older records. */
    agentModel: text('agent_model'),
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
    editedByModel: text('edited_by_model'),
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
    editedByModel: text('edited_by_model'),
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
    updatedByModel: text('updated_by_model'),
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
    updatedByModel: text('updated_by_model'),
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
 * Reports: bugs captured on the phone (text, photos, screen recordings, voice) and recordings of meetings and
 * conversations; usually for one project, possibly none. The human writes the description; an agent writes the
 * triage (for a bug the cause and tasks, for a recording a summary, decisions and tasks).
 */
export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** null: no project yet (the user assigns one in the UI; agents never do). */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** Written by an agent: what is wrong and the tasks to fix it (Markdown). */
    triage: text('triage').notNull().default(''),
    status: reportStatus('status').notNull().default('new'),
    source: memorySource('source').notNull(),
    /** Who wrote the current version: 'human' or the agent label. */
    editedBy: text('edited_by').notNull(),
    editedByModel: text('edited_by_model'),
    version: integer('version').notNull().default(1),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** The user keeps the video and audio after closing: the purge skips the report while this is on. */
    keepMedia: boolean('keep_media').notNull().default(false),
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
    createdByModel: text('created_by_model'),
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

/** A line changed after the worker wrote it: who changed it last, when, and the worker's own text and speaker (kept from the first edit). */
export type SegmentEdit = { by: 'user' | 'agent'; at: string; original: { text: string; speaker?: string } };

/** One line of a transcript; times in milliseconds from the start of the recording; `speaker` "S1"… when diarized. */
export type TranscriptSegment = { start_ms: number; end_ms: number; text: string; speaker?: string; edit?: SegmentEdit };

/** How the speakers were recognized: the model and how many speak, or why it failed. */
export type Diarization = { model: string; speakers: number } | { error: string };

/** A speaker's name, given by the user or by an agent, and when (for "most recently used" suggestions). */
export type SpeakerName = { name: string; by: 'user' | 'agent'; at: string };
export type SpeakerNames = Record<string, SpeakerName>;

/**
 * A recording to transcribe. Fornax (a separate GPU job queue) does the work: the sync uploads the recording, submits a
 * job and follows it until the transcript can be stored.
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
    /** How many times the recording was submitted to Fornax (a failed upload or submit counts as well). */
    attempts: integer('attempts').notNull().default(0),
    /** Not submitted before this moment (the back-off after a failed submit). */
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    error: text('error'),
    /** The job in Fornax; null until it is submitted (and again after Try again or Transcribe again). */
    fornaxJobId: text('fornax_job_id'),
    /** Fornax's change value of the job as last seen: following it waits until the job changes. */
    fornaxChange: text('fornax_change'),
    /** Why the job waits in Fornax, one sentence from Fornax (e.g. the worker is offline). */
    note: text('note'),
    /** How far Fornax is with a running job, a whole percent 0–100; null when it does not say (or the job waits). */
    progress: integer('progress'),
    /** What Fornax is doing on a running job, one line from Fornax (e.g. "transcribing 01:23 / 10:00"). */
    progressMessage: text('progress_message'),
    /** Set while the sync uploads and submits the recording: no other sync takes the job meanwhile. */
    submitting: boolean('submitting').notNull().default(false),
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

/** Settings of the single user, one row per key (the Copy for Claude text). A missing row means the default. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messageType = pgEnum('message_type', ['request', 'report']);
export const messageStatus = pgEnum('message_status', ['new', 'in_progress', 'waiting', 'done', 'rejected']);
export const messageWaitingOn = pgEnum('message_waiting_on', ['author', 'sender']);

/**
 * Inbox: messages between projects. What was sent never changes (a trigger enforces it); only the state moves.
 * Kept apart from recall and search so that text written by another agent never reaches an unrelated session.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    toProject: text('to_project').notNull().references(() => projects.id, { onDelete: 'restrict' }),
    /** Declared by the sender; nothing verifies it. */
    fromProject: text('from_project').notNull().references(() => projects.id, { onDelete: 'restrict' }),
    type: messageType('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    relatedTo: uuid('related_to').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
    status: messageStatus('status').notNull().default('new'),
    waitingOn: messageWaitingOn('waiting_on'),
    version: integer('version').notNull().default(1),
    source: memorySource('source').notNull(),
    createdBy: text('created_by').notNull(),
    createdByModel: text('created_by_model'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('messages_to_status_idx').on(t.toProject, t.status),
    index('messages_from_status_idx').on(t.fromProject, t.status),
    index('messages_updated_idx').on(t.updatedAt),
    check('messages_title_len', sql`char_length(${t.title}) between 1 and 200`),
    check('messages_body_len', sql`char_length(${t.body}) between 1 and 50000`),
    check('messages_waiting_on', sql`(${t.status} = 'waiting') = (${t.waitingOn} IS NOT NULL)`),
  ],
);

/** The history of a message, one entry per version; entries are never changed. */
export const messageEvents = pgTable(
  'message_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    source: memorySource('source').notNull(),
    actor: text('actor').notNull(),
    actorModel: text('actor_model'),
    version: integer('version').notNull(),
    fromStatus: messageStatus('from_status'),
    toStatus: messageStatus('to_status'),
    waitingOn: messageWaitingOn('waiting_on'),
    reply: text('reply'),
  },
  (t) => [
    uniqueIndex('message_events_version_idx').on(t.messageId, t.version),
    check('message_events_reply_len', sql`char_length(${t.reply}) <= 20000`),
  ],
);

/** Narrow tokens: each opens only the Inbox of one project. The value itself is never stored. */
export const messageTokens = pgTable(
  'message_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    tokenSha256: text('token_sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('message_tokens_sha256_idx').on(t.tokenSha256)],
);

export const oauthResource = pgEnum('oauth_resource', ['mcp', 'api']);

/** Clients that registered themselves (RFC 7591). Public clients: no secret. Unapproved ones are swept after 24 h. */
export const oauthClients = pgTable('oauth_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** As the client sent it: unverified, possibly hostile; shown only as text. */
  clientName: text('client_name'),
  redirectUris: text('redirect_uris').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** An authorization request between the consent page and the decision; single use, 10 minutes. */
export const oauthPending = pgTable('oauth_pending', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  resource: oauthResource('resource').notNull(),
  scope: text('scope').notNull(),
  state: text('state'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** One approval of one app: its name labels everything the app writes. Revoking it ends every token issued under it. */
export const oauthConnections = pgTable(
  'oauth_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => oauthClients.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    resource: oauthResource('resource').notNull(),
    scope: text('scope').notNull(),
    /** The redirect URI the approval answered to: where the access went. */
    redirectUri: text('redirect_uri').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('oauth_connections_live_name_idx').on(t.name).where(sql`${t.revokedAt} IS NULL`),
    index('oauth_connections_client_idx').on(t.clientId),
  ],
);

export const oauthCodes = pgTable('oauth_codes', {
  /** SHA-256 (hex) of the code; the code itself is never stored. */
  hash: text('hash').primaryKey(),
  connectionId: uuid('connection_id').notNull().references(() => oauthConnections.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  resource: oauthResource('resource').notNull(),
  scope: text('scope').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    hash: text('hash').primaryKey(),
    connectionId: uuid('connection_id').notNull().references(() => oauthConnections.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * Set when the token was rotated. Presenting it again within 10 s is refused without revoking (a client retrying
     * a lost answer); presenting it again later revokes the whole connection.
     */
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oauth_refresh_tokens_connection_idx').on(t.connectionId)],
);

export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    hash: text('hash').primaryKey(),
    connectionId: uuid('connection_id').notNull().references(() => oauthConnections.id, { onDelete: 'cascade' }),
    /** The audience: a token for /mcp opens only /mcp, a token for /api only /api. */
    resource: oauthResource('resource').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oauth_access_tokens_connection_idx').on(t.connectionId)],
);

/** The owner's passkeys (one user, any number of devices). The last one cannot be deleted. */
export const passkeys = pgTable(
  'passkeys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** base64url credential id, as WebAuthn reports it. */
    credentialId: text('credential_id').notNull(),
    /** base64url COSE public key. */
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array().notNull().default(sql`'{}'::text[]`),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('passkeys_credential_idx').on(t.credentialId),
    check('passkeys_name_len', sql`char_length(${t.name}) between 1 and 60`),
  ],
);

export const passkeyRegistrationKind = pgEnum('passkey_registration_kind', ['link', 'add']);

/**
 * Permission to register one passkey: a link printed by the server ("link": the first passkey and recovery; a new
 * link ends the older ones) or a token the server puts into the Add passkey page ("add"). Single use, 15 minutes.
 */
export const passkeyRegistrations = pgTable(
  'passkey_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: passkeyRegistrationKind('kind').notNull(),
    tokenSha256: text('token_sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('passkey_registrations_sha256_idx').on(t.tokenSha256)],
);

export const webauthnPurpose = pgEnum('webauthn_purpose', ['login', 'register']);

/** A WebAuthn challenge the server issued: single use, 5 minutes; stored only as a hash. */
export const webauthnChallenges = pgTable('webauthn_challenges', {
  challengeSha256: text('challenge_sha256').primaryKey(),
  purpose: webauthnPurpose('purpose').notNull(),
  /** A registration challenge belongs to one registration permission. */
  registrationId: uuid('registration_id').references(() => passkeyRegistrations.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Web UI sessions (the HttpOnly cookie). `verified_at`: the last passkey check, for actions that need a fresh one. */
export const uiSessions = pgTable(
  'ui_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenSha256: text('token_sha256').notNull(),
    userAgent: text('user_agent').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('ui_sessions_sha256_idx').on(t.tokenSha256)],
);

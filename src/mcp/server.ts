import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  type AgentContext, agentDeprecate, agentFindNotes, agentFindThoughts, agentGet, agentListFiles, agentListProjects,
  agentDeleteFile, agentReadFile, agentRecall, agentRemember, agentSaveThought, agentSearch, agentUpdateThought, agentWriteFile,
  agentCreateReport, agentGetFrame, agentGetReport, agentGetTranscript, agentListReports, agentUpdateReport, agentViewAttachment, type AgentImage,
  type AgentBlock, type AgentFileRead,
} from '../agent/operations.js';
import { REPORT_STATUSES } from '../domain/reports.js';
import { badRequest, DomainError, loggableError } from '../domain/errors.js';
import { createProject } from '../domain/projects.js';
import { MEMORY_KINDS, validateProjectSlug } from '../domain/validation.js';
import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS as D } from './descriptions.js';
import { claudeMdSection, TABULA_JSON } from './snippet.js';

/** Returned by setup_project: the first push uploads everything "sync" matches, so look before it does. */
const SETUP_NEXT_STEP =
  'Save tabula_json as .tabula.json in the repository root, then run `tabula status` before the first `tabula push` and check the files it lists; narrow "sync" if it would upload more than the untracked files meant for Tabula.';

const idParam = z.string().describe('A reference "tabula:xxxxxxxx", a full uuid, or the short #xxxx id shown in recall.');
const projectParam = z.string().describe('Project slug from the "Memory (Tabula)" section, e.g. "acme".');
const kindParam = z.enum(MEMORY_KINDS);

/** Logger is optional only for places where the server is built without a request (e.g. tests). */
export type McpLogger = { error(obj: unknown): void };
export type McpContext = AgentContext & { log?: McpLogger };

/** Like runTool, for tools that answer with an image (and a line of JSON about it). */
async function runImageTool(log: McpLogger | undefined, fn: () => Promise<AgentImage>) {
  try {
    const r = await fn();
    return {
      content: [
        { type: 'image' as const, data: r.image.toString('base64'), mimeType: r.mime },
        { type: 'text' as const, text: r.text },
      ],
    };
  } catch (e) {
    return runTool(log, () => Promise.reject(e));
  }
}

/** get answers in separate blocks: the headline first, then JSON, a file's text or an image. */
async function runBlocks(log: McpLogger | undefined, fn: () => Promise<AgentBlock[]>) {
  try {
    const blocks = await fn();
    return {
      content: blocks.map((b) =>
        b.type === 'text'
          ? { type: 'text' as const, text: b.text }
          : { type: 'image' as const, data: b.image.toString('base64'), mimeType: b.mime },
      ),
    };
  } catch (e) {
    return runTool(log, () => Promise.reject(e));
  }
}

/** read_file answers in separate text blocks, so the file's text is never mixed with the header or the footer. */
async function runFileRead(log: McpLogger | undefined, fn: () => Promise<AgentFileRead>) {
  try {
    const r = await fn();
    const blocks = [r.header, r.text, r.footer].filter((t): t is string => t !== undefined);
    return { content: blocks.map((text) => ({ type: 'text' as const, text })) };
  } catch (e) {
    return runTool(log, () => Promise.reject(e));
  }
}

async function runTool(log: McpLogger | undefined, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return { content: [{ type: 'text' as const, text }] };
  } catch (e) {
    if (e instanceof DomainError) {
      if (e.cause) log?.error({ err: loggableError(e.cause), msg: e.message });
      return { content: [{ type: 'text' as const, text: `${e.status}: ${e.message}` }], isError: true };
    }
    log?.error(loggableError(e));
    return { content: [{ type: 'text' as const, text: '500: internal error in Tabula; retry later' }], isError: true };
  }
}

export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'tabula', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });
  const run = (fn: () => Promise<unknown>) => runTool(ctx.log, fn);

  server.registerTool('list_projects', { description: D.list_projects, inputSchema: z.object({}) }, () =>
    run(() => agentListProjects(ctx)),
  );

  server.registerTool(
    'recall',
    {
      description: D.recall,
      inputSchema: z.object({
        project: projectParam,
        include_state: z.boolean().default(true).describe('Include the content of the project state files. Pass false only when the `tabula` command restored them to disk (Claude Code on a computer with the repository).'),
      }),
    },
    ({ project, include_state }) => run(() => agentRecall(ctx, project, include_state)),
  );

  server.registerTool(
    'search',
    {
      description: D.search,
      inputSchema: z.object({
        query: z.string().min(1).describe('Words to look for; supports "quoted phrases", OR and -exclusion.'),
        project: projectParam.optional().describe('Search this project\'s files (global rules are always included). Omit to search the files of every project.'),
        kind: kindParam.optional().describe('Only global memories of this kind (excludes files).'),
        include_deprecated: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    },
    (a) =>
      run(() =>
        agentSearch(ctx, { query: a.query, project: a.project, kind: a.kind, includeDeprecated: a.include_deprecated, limit: a.limit }),
      ),
  );

  server.registerTool('get', { description: D.get, inputSchema: z.object({ id: idParam }) }, ({ id }) =>
    runBlocks(ctx.log, () => agentGet(ctx, id)),
  );

  server.registerTool(
    'remember',
    {
      description: D.remember,
      inputSchema: z.object({
        project: z.string().describe('Must be "global": Tabula keeps only global rules.'),
        kind: kindParam.describe('rule = how to do things; decision = what was chosen and why; fact = state of the world not in code; gotcha = a trap already hit.'),
        title: z.string().describe('One line, max 120 characters.'),
        body: z.string().describe('The why and the context in 1–5 sentences, max 2000 characters.'),
        tags: z.array(z.string()).optional().describe('Free lowercase tags.'),
        supersedes_id: idParam.optional().describe('Id of the rule this one replaces; it will be deprecated.'),
      }),
    },
    (a) => run(() => agentRemember(ctx, a)),
  );

  server.registerTool(
    'deprecate',
    {
      description: D.deprecate,
      inputSchema: z.object({ id: idParam, reason: z.string().describe('Why the rule is no longer valid.') }),
    },
    (a) => run(() => agentDeprecate(ctx, a)),
  );

  server.registerTool(
    'setup_project',
    {
      description: D.setup_project,
      inputSchema: z.object({
        id: z.string().describe('Project slug = project folder name in lowercase (letters, digits, dashes, max 40).'),
        name: z.string().optional().describe('Display name; defaults to the slug.'),
        description: z.string().optional().describe('One sentence about the project.'),
      }),
    },
    (a) =>
      run(async () => {
        const id = validateProjectSlug(a.id);
        if (id === 'global') {
          throw badRequest('"global" is not a project to onboard; it holds rules shared by every project. Use the project folder name as the slug.');
        }
        const existing = (await agentListProjects(ctx)).find((p) => p.id === id);
        const result = { claude_md_section: claudeMdSection(id), tabula_json: TABULA_JSON, next_step: SETUP_NEXT_STEP };
        if (existing) return { created: false, project: existing, ...result };
        const project = await createProject(ctx.db, { id, name: a.name ?? id, description: a.description });
        return { created: true, project, ...result };
      }),
  );

  server.registerTool('list_files', { description: D.list_files, inputSchema: z.object({ project: projectParam }) }, ({ project }) =>
    run(() => agentListFiles(ctx, project)),
  );

  server.registerTool(
    'read_file',
    {
      description: D.read_file,
      inputSchema: z.object({
        project: projectParam,
        path: z.string().describe('Path relative to the repository root, exactly as list_files shows it.'),
        offset: z.number().int().min(0).default(0).describe('Character offset for long files; the previous reply names it.'),
      }),
    },
    (a) => runFileRead(ctx.log, () => agentReadFile(ctx, a)),
  );

  const sha256Param = z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex sha256 (64 characters)');

  server.registerTool(
    'write_file',
    {
      description: D.write_file,
      inputSchema: z.object({
        project: projectParam,
        path: z.string().describe('Path relative to the repository root, e.g. "docs/superpowers/specs/2026-11-02-topic.md"; must match the project\'s sync patterns.'),
        content: z.string().describe('The whole new text of the file (UTF-8, at most 1 MiB).'),
        base_sha256: sha256Param.optional().describe('The sha256 from the read_file header of the version you changed. Required when the file exists; omit for a new file.'),
      }),
    },
    (a) => run(() => agentWriteFile(ctx, a)),
  );

  server.registerTool(
    'delete_file',
    {
      description: D.delete_file,
      inputSchema: z.object({
        project: projectParam,
        path: z.string().describe('Path exactly as list_files shows it.'),
        base_sha256: sha256Param.describe('The sha256 of the current version, from list_files or the read_file header.'),
      }),
    },
    (a) => run(() => agentDeleteFile(ctx, a)),
  );

  server.registerTool(
    'find_notes',
    {
      description: D.find_notes,
      inputSchema: z.object({
        query: z.string().optional().describe('Words to look for (prefix match). Omit for the newest notes.'),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    },
    (a) => run(() => agentFindNotes(ctx, a)),
  );

  const tagsParam = z.array(z.string()).optional().describe('Free lowercase tags, e.g. topic words.');

  server.registerTool(
    'save_thought',
    {
      description: D.save_thought,
      inputSchema: z.object({
        title: z.string().describe('Specific one-line title, max 200 characters.'),
        body: z.string().describe('Markdown, max 50 000 characters.'),
        tags: tagsParam,
      }),
    },
    (a) => run(() => agentSaveThought(ctx, a)),
  );

  server.registerTool(
    'update_thought',
    {
      description: D.update_thought,
      inputSchema: z.object({
        id: idParam,
        title: z.string().optional(),
        body: z.string().optional().describe('Replaces the whole body.'),
        append: z.string().optional().describe('Markdown added at the end after a blank line.'),
        tags: z.array(z.string()).optional().describe('Replaces all tags.'),
        expected_version: z.number().int().positive().optional().describe('The version you read (from get or find_thoughts). Required with body or title; optional with append only.'),
      }),
    },
    (a) => run(() => agentUpdateThought(ctx, a)),
  );

  server.registerTool(
    'find_thoughts',
    {
      description: D.find_thoughts,
      inputSchema: z.object({
        query: z.string().optional().describe('Words to look for (prefix match). Omit for the newest thoughts.'),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    },
    (a) => run(() => agentFindThoughts(ctx, a)),
  );

  const reportId = z.string().describe('Report: its reference (tabula:xxxxxxxx), a full uuid or the short #xxxx id.');
  const attachmentId = z.string().describe('Attachment: its reference (tabula:xxxxxxxx) from get_report, a full uuid or its first 8+ characters.');

  server.registerTool(
    'list_reports',
    {
      description: D.list_reports,
      inputSchema: z.object({
        project: z.string().optional().describe('Project slug; omit for every project.'),
        status: z.enum([...REPORT_STATUSES, 'open', 'all']).default('open').describe('"open" = new and triaged.'),
        query: z.string().optional().describe('Words to look for (prefix match).'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    },
    (a) => run(() => agentListReports(ctx, a)),
  );

  server.registerTool('get_report', { description: D.get_report, inputSchema: z.object({ id: reportId }) }, ({ id }) =>
    run(() => agentGetReport(ctx, id)),
  );

  server.registerTool(
    'create_report',
    {
      description: D.create_report,
      inputSchema: z.object({
        project: z.string().describe('Project slug the bug belongs to, as list_projects shows it.'),
        title: z.string().describe('What is broken, one line, max 200 characters.'),
        description: z.string().optional().describe('Markdown: what happened, steps to reproduce, expected result.'),
      }),
    },
    (a) => run(() => agentCreateReport(ctx, a)),
  );

  server.registerTool(
    'update_report',
    {
      description: D.update_report,
      inputSchema: z.object({
        id: reportId,
        triage: z.string().optional().describe('Replaces the whole triage (Markdown).'),
        append_triage: z.string().optional().describe('Markdown added at the end of the triage.'),
        status: z.enum(REPORT_STATUSES).optional(),
        title: z.string().optional(),
        expected_version: z.number().int().positive().optional().describe('The version from get_report. Required with triage, title or status "done".'),
      }),
    },
    (a) => run(() => agentUpdateReport(ctx, a)),
  );

  server.registerTool('view_attachment', { description: D.view_attachment, inputSchema: z.object({ id: attachmentId }) }, ({ id }) =>
    runImageTool(ctx.log, () => agentViewAttachment(ctx, id)),
  );

  server.registerTool(
    'get_frame',
    {
      description: D.get_frame,
      inputSchema: z.object({
        video_id: attachmentId,
        at: z.union([z.string(), z.number()]).describe('"2:41", "1:02:03" or seconds (161.5).'),
      }),
    },
    (a) => runImageTool(ctx.log, () => agentGetFrame(ctx, a)),
  );

  server.registerTool(
    'get_transcript',
    {
      description: D.get_transcript,
      inputSchema: z.object({
        attachment_id: attachmentId,
        offset: z.number().int().min(0).default(0).describe("Character offset; the previous reply's last line names it."),
      }),
    },
    (a) => run(() => agentGetTranscript(ctx, a)),
  );

  return server;
}

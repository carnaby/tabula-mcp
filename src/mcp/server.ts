import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  type AgentContext, agentDeprecate, agentFindNotes, agentFindThoughts, agentGet, agentListFiles, agentListProjects,
  agentReadFile, agentRecall, agentRemember, agentSaveThought, agentSearch, agentUpdateThought,
} from '../agent/operations.js';
import { badRequest, DomainError } from '../domain/errors.js';
import { createProject } from '../domain/projects.js';
import { MEMORY_KINDS, validateProjectSlug } from '../domain/validation.js';
import { TOOL_DESCRIPTIONS as D } from './descriptions.js';
import { claudeMdSection, TABULA_JSON } from './snippet.js';

const SERVER_INSTRUCTIONS = `Tabula keeps each project's files that are not in git (handoff state, private specs and plans) and the global rules that apply to every project. It ranks below the code and the client's own local memory: on a conflict they win.
Use Tabula for a project only when its CLAUDE.md (or project instructions) has a "Memory (Tabula)" section naming its Tabula project. Without that section do not call recall, search, list_files or read_file, and never guess a project slug.
Never write project memories: remember and deprecate work only on global rules, and only when the user explicitly asks.
When the user explicitly asks to start using Tabula in a project: call setup_project with the project folder name as the slug, put the section it returns into CLAUDE.md (create the file if it is missing; replace an older "Memory (Tabula)" section), save the suggested .tabula.json in the repository root, then call recall.
Thoughts and Notes need no such section and work anywhere. Thoughts are the user's notebook of saved conversations: when the user explicitly asks to save something to Tabula, or to find or change a saved thought, use find_thoughts, save_thought and update_thought. Notes are the user's own notes: read them with find_notes and get only when the user mentions their notes.`;

const idParam = z.string().describe('Full uuid or the short #xxxx id shown in recall and search.');
const projectParam = z.string().describe('Project slug from the "Memory (Tabula)" section, e.g. "acme".');
const kindParam = z.enum(MEMORY_KINDS);

/** Logger is optional only for places where the server is built without a request (e.g. tests). */
export type McpLogger = { error(obj: unknown): void };
export type McpContext = AgentContext & { log?: McpLogger };

async function runTool(log: McpLogger | undefined, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return { content: [{ type: 'text' as const, text }] };
  } catch (e) {
    if (e instanceof DomainError) {
      return { content: [{ type: 'text' as const, text: `${e.status}: ${e.message}` }], isError: true };
    }
    log?.error(e);
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
        include_state: z.boolean().default(true).describe('Include the content of the project state files. Claude Code passes false: the files are on disk.'),
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
    run(() => agentGet(ctx, id)),
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
        const result = { claude_md_section: claudeMdSection(id), tabula_json: TABULA_JSON };
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
    (a) => run(() => agentReadFile(ctx, a)),
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

  return server;
}

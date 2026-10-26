import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { notFound } from '../domain/errors.js';
import {
  createMemory, deleteMemory, deprecateMemory, getMemory, MEMORY_SORTS, pageMemories, supersedesChain, updateMemory,
} from '../domain/memories.js';
import { createNote, deleteNote, getNote, NOTE_SORTS, type Note, noteTags, pageNotes, updateNote } from '../domain/notes.js';
import { MAX_PAGE_SIZE } from '../domain/paging.js';
import { createProject, listProjects, requireProject, updateProject } from '../domain/projects.js';
import { quickSearch } from '../domain/search.js';
import {
  createThought, deleteThought, getThought, HUMAN, listRevisions, pageThoughts, restoreRevision, THOUGHT_SORTS,
  thoughtTags, updateThought,
} from '../domain/thoughts.js';
import { claudeMdSection } from '../mcp/snippet.js';
import { recall } from '../domain/recall.js';
import { DIGEST_BUDGET, estimateTokens, wordCount } from '../domain/tokens.js';
import { MEMORY_KINDS } from '../domain/validation.js';
import { requireBearer } from './auth.js';
import { fileRoutes } from './files-api.js';
import { parse } from './parse.js';

const kind = z.enum(MEMORY_KINDS);
const tags = z.array(z.string()).optional();
const idParams = z.object({ id: z.uuid() });

const paging = <S extends readonly [string, ...string[]]>(sorts: S) => ({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  sort: z.enum(sorts).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

const withSize = (n: Note) => ({ ...n, wordCount: wordCount(n.body), tokenEstimate: estimateTokens(n.body) });

export const apiRoutes: FastifyPluginAsync<{ db: Db; config: Config }> = async (app, { db, config }) => {
  app.addHook('preHandler', requireBearer(config.token));
  // Child plugin: inherits the bearer preHandler above.
  await app.register(fileRoutes, { db });

  // Projects
  app.get('/projects', () => listProjects(db));
  app.post('/projects', async (req, reply) => {
    const body = parse(z.object({ id: z.string(), name: z.string(), description: z.string().optional() }), req.body);
    return reply.code(201).send(await createProject(db, body));
  });
  app.patch('/projects/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    return updateProject(db, id, parse(z.object({ name: z.string().optional(), description: z.string().optional() }), req.body));
  });
  app.get('/projects/:id/snippet', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await requireProject(db, id);
    return { text: claudeMdSection(id) };
  });

  // Memories
  app.get('/memories', (req) => {
    const q = parse(
      z.object({
        project: z.string().optional(),
        kind: kind.optional(),
        status: z.enum(['active', 'deprecated', 'all']).optional(),
        source: z.enum(['agent', 'human']).optional(),
        q: z.string().optional(),
        ...paging(MEMORY_SORTS),
      }),
      req.query,
    );
    const { project, ...rest } = q;
    return pageMemories(db, { ...rest, projectId: project });
  });
  app.post('/memories', async (req, reply) => {
    const b = parse(
      z.object({
        projectId: z.string(), kind, title: z.string(), body: z.string(), tags,
        supersedesId: z.uuid().nullable().optional(),
      }),
      req.body,
    );
    return reply.code(201).send(await createMemory(db, { ...b, source: 'human', agentLabel: null }));
  });
  app.patch('/memories/:id', (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ title: z.string().optional(), body: z.string().optional(), tags, kind: kind.optional() }), req.body);
    return updateMemory(db, id, b);
  });
  app.post('/memories/:id/deprecate', (req) => {
    const { id } = parse(idParams, req.params);
    return deprecateMemory(db, id, parse(z.object({ reason: z.string() }), req.body).reason);
  });
  app.delete('/memories/:id', async (req, reply) => {
    await deleteMemory(db, parse(idParams, req.params).id);
    return reply.code(204).send();
  });
  app.get('/memories/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const m = await getMemory(db, id);
    if (!m) throw notFound(`memory ${id} does not exist`);
    return m;
  });
  app.get('/memories/:id/chain', (req) => supersedesChain(db, parse(idParams, req.params).id));

  // Notes
  app.get('/notes', async (req) => {
    const q = parse(z.object({ project: z.string().optional(), q: z.string().optional(), tag: z.string().optional(), ...paging(NOTE_SORTS) }), req.query);
    const { project, ...rest } = q;
    const page = await pageNotes(db, { ...rest, projectId: project });
    return { ...page, items: page.items.map(withSize) };
  });
  app.get('/notes/tags', () => noteTags(db));
  app.get('/notes/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const n = await getNote(db, id);
    if (!n) throw notFound(`note ${id} does not exist`);
    return withSize(n);
  });
  const noteFields = {
    title: z.string(), summary: z.string().optional(), body: z.string().optional(), tags, pinned: z.boolean().optional(),
  };
  app.post('/notes', async (req, reply) => {
    const b = parse(z.object({ projectId: z.string().nullable().optional(), ...noteFields }), req.body);
    return reply.code(201).send(withSize(await createNote(db, b)));
  });
  app.patch('/notes/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ ...noteFields, title: z.string().optional() }), req.body);
    return withSize(await updateNote(db, id, b));
  });
  app.delete('/notes/:id', async (req, reply) => {
    await deleteNote(db, parse(idParams, req.params).id);
    return reply.code(204).send();
  });

  // Thoughts: the personal notebook outside projects
  app.get('/thoughts', (req) => {
    const q = parse(
      z.object({
        q: z.string().optional(),
        tag: z.string().optional(),
        archived: z.enum(['true', 'false', 'all']).optional(),
        source: z.enum(['agent', 'human']).optional(),
        ...paging(THOUGHT_SORTS),
      }),
      req.query,
    );
    const archived = q.archived === 'all' ? 'all' : q.archived === 'true';
    return pageThoughts(db, { ...q, archived });
  });
  app.get('/thoughts/tags', () => thoughtTags(db));
  app.get('/thoughts/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const t = await getThought(db, id);
    if (!t) throw notFound(`thought ${id} does not exist`);
    return t;
  });
  app.post('/thoughts', async (req, reply) => {
    const b = parse(
      z.object({ title: z.string(), body: z.string().optional(), tags, pinned: z.boolean().optional() }),
      req.body,
    );
    return reply.code(201).send(await createThought(db, b, HUMAN));
  });
  app.patch('/thoughts/:id', (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(
      z.object({
        title: z.string().optional(), body: z.string().optional(), tags, pinned: z.boolean().optional(),
        archived: z.boolean().optional(), expectedVersion: z.number().int().positive().optional(),
      }),
      req.body,
    );
    return updateThought(db, id, b, HUMAN);
  });
  app.delete('/thoughts/:id', async (req, reply) => {
    await deleteThought(db, parse(idParams, req.params).id);
    return reply.code(204).send();
  });
  app.get('/thoughts/:id/revisions', (req) => listRevisions(db, parse(idParams, req.params).id));
  app.post('/thoughts/:id/revisions/:revisionId/restore', (req) => {
    const { id, revisionId } = parse(z.object({ id: z.uuid(), revisionId: z.uuid() }), req.params);
    return restoreRevision(db, id, revisionId, HUMAN);
  });

  // Global search box
  app.get('/search', (req) => {
    const q = parse(z.object({ q: z.string(), limit: z.coerce.number().int().min(1).max(50).optional() }), req.query);
    return quickSearch(db, q);
  });

  // Recall preview
  app.get('/recall/:project', async (req) => {
    const { project } = parse(z.object({ project: z.string() }), req.params);
    const { state } = parse(z.object({ state: z.enum(['0', '1']).optional() }), req.query);
    const d = await recall(db, project, { includeState: state !== '0' });
    return { ...d, budget: DIGEST_BUDGET };
  });
};

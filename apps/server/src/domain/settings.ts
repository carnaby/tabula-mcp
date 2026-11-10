import { copyPromptProblem, DEFAULT_COPY_PROMPT, normalizeCopyPrompt } from '@tabula/shared/copy-prompt';
import { DEFAULT_TIDY_PROMPT } from '@tabula/shared/tidy-prompt';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { badRequest } from './errors.js';

type TextValue = { text: string };

/** A user text kept in `settings`, or the default when none is saved. */
async function readText(db: Db, key: string, fallback: string): Promise<string> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  const text = (row?.value as TextValue | undefined)?.text;
  return typeof text === 'string' && text ? text : fallback;
}

/** Saves the text, trimmed; an empty one deletes the row and goes back to the default. Returns the text in use. */
async function saveText(db: Db, key: string, raw: string, fallback: string): Promise<string> {
  const text = normalizeCopyPrompt(raw);
  const problem = copyPromptProblem(text);
  if (problem) throw badRequest(problem);
  if (!text) {
    await db.delete(settings).where(eq(settings.key, key));
    return fallback;
  }
  const value: TextValue = { text };
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  return text;
}

/** The text Copy for Claude puts on the clipboard, with `{ref}` where the report's reference goes. */
export const getCopyPrompt = (db: Db) => readText(db, 'copy_prompt', DEFAULT_COPY_PROMPT);
export const setCopyPrompt = (db: Db, raw: string) => saveText(db, 'copy_prompt', raw, DEFAULT_COPY_PROMPT);

/** The text Copy puts on the clipboard for a project whose recall is trimmed, with `{project}` for its slug. */
export const getTidyPrompt = (db: Db) => readText(db, 'tidy_prompt', DEFAULT_TIDY_PROMPT);
export const setTidyPrompt = (db: Db, raw: string) => saveText(db, 'tidy_prompt', raw, DEFAULT_TIDY_PROMPT);

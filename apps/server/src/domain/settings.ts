import { copyPromptProblem, DEFAULT_COPY_PROMPT, normalizeCopyPrompt } from '@tabula/shared/copy-prompt';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { badRequest } from './errors.js';

const COPY_PROMPT = 'copy_prompt';
type CopyPromptValue = { text: string };

/** The text Copy for Claude puts on the clipboard, with `{ref}` where the report's reference goes. */
export async function getCopyPrompt(db: Db): Promise<string> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, COPY_PROMPT));
  const text = (row?.value as CopyPromptValue | undefined)?.text;
  return typeof text === 'string' && text ? text : DEFAULT_COPY_PROMPT;
}

/** Saves the text, trimmed; an empty one goes back to the default. Returns what Copy for Claude will use. */
export async function setCopyPrompt(db: Db, raw: string): Promise<string> {
  const text = normalizeCopyPrompt(raw);
  const problem = copyPromptProblem(text);
  if (problem) throw badRequest(problem);
  if (!text) {
    await db.delete(settings).where(eq(settings.key, COPY_PROMPT));
    return DEFAULT_COPY_PROMPT;
  }
  const value: CopyPromptValue = { text };
  await db
    .insert(settings)
    .values({ key: COPY_PROMPT, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  return text;
}

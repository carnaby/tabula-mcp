// The text Copy puts on the clipboard for a project whose recall is trimmed. No imports: @tabula/shared stays dependency-free.

/** Where the project's slug goes. */
export const PROJECT_PLACEHOLDER = '{project}';

export const DEFAULT_TIDY_PROMPT = [
  'Tidy the Tabula recall of project {project}. Its recall no longer fits the budget, mostly because the state files grew.',
  '',
  '1. Call recall for {project} with include_state: true and read each state file in full (read_file, or the file on disk in its repository).',
  '2. In each state file keep only what is true now: the verified state, what is running, next steps, open questions and a short backlog.',
  '3. Move everything else (finished milestones, history, closed decisions) word for word to the top of an archive file in an archive folder beside the state file (<folder>/archive/<name>-<YYYY-MM>.md, e.g. docs/handoff/handoff.md → docs/handoff/archive/handoff-<YYYY-MM>.md), under a heading with today\'s date. The archive must match the project\'s "sync" patterns in .tabula.json and must not match its "state" patterns; if it would not, stop and tell me. Do not change .tabula.json.',
  '4. Delete nothing: every line that leaves a state file must be in the archive. Add one line to the state file that points to the archive.',
  '5. Save: in Claude Code edit the files on disk and run `tabula push`; where the tabula command is not available, use write_file.',
  '6. Call recall again and check that no state file is cut off ("[… truncated") or left out ("[omitted to fit the budget"). If the global rules, not the state, fill the recall, say so and leave them unchanged.',
  '7. Tell me what you moved, where, and roughly how big the recall is now (its characters divided by 4 is about its tokens; the budget is 3 000).',
].join('\n');

/** What Copy puts on the clipboard: every `{project}` becomes the slug; a text without one gets a "Project:" line at the end. */
export function fillTidyPrompt(text: string, project: string): string {
  return text.includes(PROJECT_PLACEHOLDER) ? text.split(PROJECT_PLACEHOLDER).join(project) : `${text}\nProject: ${project}`;
}

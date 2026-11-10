// The text Tidy with Claude puts on the clipboard on the Thoughts page. No imports: @tabula/shared stays dependency-free.

export const DEFAULT_COMPACT_PROMPT = [
  'Tidy my Tabula notebook (Thoughts). Thoughts saved from long chats tend to mix several topics, repeat each other, or spread one topic over several thoughts.',
  '',
  '1. Read the thoughts: call find_thoughts with limit 50, then offset 50, 100, … until a page has fewer than 50, and get each one in full. Work on all active thoughts, or only on those a line at the end of this text names.',
  '2. Propose a plan and change nothing yet. List each change: merge (one topic spread over several thoughts, or duplicates) or split (one thought with unrelated topics). For each resulting thought give its title, tags and source thoughts (their tabula: references). Name the thoughts you would leave as they are.',
  '3. Wait for my answer. Do only what I approve; if I change the plan, show the new plan first.',
  '4. Carry it out. Create each new thought with save_thought. Keep every fact, decision, number, link and open question of its sources; you may reorder and rewrite, but leave nothing out. End each new thought with a line "Sources: tabula:… tabula:…". Then archive each source thought with update_thought and archived: true. Delete nothing.',
  '5. Check that nothing is lost: read each archived source again and confirm every detail is in one of the new thoughts; add anything missing with update_thought and append.',
  '6. Tell me what you created and what you archived, with references. Archived thoughts stay under Thoughts → Archived and keep their version history.',
].join('\n');

/** What Tidy with Claude copies: the text, plus a last line naming the tag when the list is filtered by one. */
export function fillCompactPrompt(text: string, tag?: string): string {
  return tag ? `${text}\nOnly the thoughts tagged "${tag}".` : text;
}

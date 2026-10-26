export const TOOL_DESCRIPTIONS = {
  list_projects: `List Tabula projects: slug, one-line description, number of active memories and notes.
Call it when you are unsure which project slug to use. Never invent a slug; projects are created by the human or, on the user's explicit request, by setup_project.`,

  recall: `Call at the start of a session, before reading code, when the project's CLAUDE.md (or project instructions) names a Tabula project. Returns the active rules, gotchas, decisions and facts for that project plus global ones. Without such a section do not call it, and never guess a slug. Do not call search for things already in the digest.`,

  search: `Full-text search over memories and notes. Use before remember to
check whether a similar record already exists, and when you need something
specific that the recall digest did not contain.`,

  get: `Fetch the full body of one memory, note or thought by id. Notes can be long;
fetch them only when the summary in recall is not enough.`,

  remember: `Persist a durable rule, decision, fact or gotcha for a project.
Write it only when it will still matter in a future session and is not
obvious from the code. Do NOT record task progress, TODOs, or restatements
of what CLAUDE.md already says. Always search first; if a record covers the
same topic, pass its id as supersedes_id instead of creating a duplicate.
Title: one line, imperative for rules ("Run tests via pnpm test:unit").
Body: the why and the context in 1–5 sentences.
Write only if all three hold: it will still be true in a month; it is not
visible in the code or CLAUDE.md; a future session would lose time without it.
Expect 0–3 records per session. Never store secrets (passwords, keys, tokens),
not even as a fact.`,

  deprecate: `Mark a memory as no longer valid, with a reason. Use when the
code or a decision has changed. You cannot deprecate human-authored records
or notes; instead, remember a fact describing the discrepancy.`,

  setup_project: `Onboard a project into Tabula. Call it ONLY when the user explicitly asks to start using Tabula in this project — never on your own initiative. Slug = the project folder name in lowercase (letters, digits, dashes). Creates the project if it does not exist yet (name defaults to the slug; give a one-sentence description of the project) and returns the "Memory (Tabula)" section to put into the project's CLAUDE.md. If the project already exists it is left unchanged and the section is returned again.`,

  save_thought: `Save a new thought to the user's personal notebook in Tabula ("Thoughts"), which belongs to no project and never appears in recall. Call it ONLY when the user explicitly asks to save something to Tabula (e.g. "save this to Tabula", "ulož mi to do tabule") — never on your own initiative.
Call find_thoughts first; if a thought on the same topic exists, tell the user and use update_thought instead of creating a duplicate.
Write it so the user can reread it months later without the conversation: a specific title; a Markdown body with the key ideas, conclusions, reasons and open questions in the user's language; no chat transcript and no filler. Never store secrets.`,

  update_thought: `Change an existing thought in the user's Tabula notebook when the user asks to add to it or fix it. Use append to add a section at the end; use body only to rewrite the whole text. The previous version is always kept and the user can restore it.
expected_version (from find_thoughts or get) is REQUIRED when you pass body or title, so you never overwrite the user's own edit; append alone may omit it; on a 409 conflict call get and apply the change again.`,

  find_thoughts: `List or search the user's personal Tabula notebook ("Thoughts"). Without query it returns the newest thoughts. Use it when the user refers to something saved earlier, and before save_thought to avoid duplicates. Returns ids and versions for get and update_thought. Works in any project; it needs no "Memory (Tabula)" section.`,
} as const;

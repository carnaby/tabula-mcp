export const TOOL_DESCRIPTIONS = {
  list_projects: `List Tabula projects: slug, one-line description, number of synced files and of active memories (global rules live in "global").
Call it when you are unsure which project slug to use. Never invent a slug; projects are created by the human or, on the user's explicit request, by setup_project.`,

  recall: `Call at the start of a session when the project's CLAUDE.md (or project instructions) names a Tabula project. Returns the global rules (follow them), the project state (the content of its handoff state files) and the list of the project's synced files. In Claude Code pass include_state: false — the state files are already on disk. Without such a section do not call it, and never guess a slug.`,

  search: `Full-text search over the global rules and the project's synced files (path and content). Use it when you need something specific that recall did not show; open a file hit with read_file. Words match exactly; use "quoted phrases", OR and -exclusion.`,

  get: `Fetch the full text of one global rule (memory), note or thought by id. Notes are the user's own notebook: read them only when the user mentions their notes.`,

  remember: `Store a global rule — something that applies to every project. Call it ONLY when the user explicitly asks to add a global rule, never on your own initiative and never for project knowledge (that belongs in the repository or in its synced files). project must be "global".
Always search first; if a rule covers the same topic, pass its id as supersedes_id instead of creating a duplicate.
Title: one line, imperative for rules ("Run tests via pnpm test:unit"). Body: the why and the context in 1–5 sentences. Never store secrets (passwords, keys, tokens).`,

  deprecate: `Mark a global rule as no longer valid, with a reason — only when the user asks. You cannot deprecate human-authored records or notes.`,

  setup_project: `Onboard a project into Tabula. Call it ONLY when the user explicitly asks to start using Tabula in this project — never on your own initiative. Slug = the project folder name in lowercase (letters, digits, dashes). Creates the project if it does not exist yet (name defaults to the slug; give a one-sentence description of the project) and returns the "Memory (Tabula)" section for the project's CLAUDE.md and a suggested .tabula.json for the repository root (which untracked files the tabula command syncs; without "project" it uses the folder name). If the project already exists it is left unchanged and both are returned again.`,

  list_files: `List the files synced into a Tabula project — the untracked files of its repository (handoff state, private specs and plans): path, size, version, date, and whether the file is part of the project state. Read one with read_file.`,

  read_file: `Read one synced file of a project (path exactly as list_files shows it). Long files come in parts of 100 000 characters; the reply ends with the offset to pass next. In Claude Code prefer the copy on disk — it is restored at session start.`,

  find_notes: `List or search the user's own notes (Tabula "Notes", a personal notebook outside projects). Call it ONLY when the user mentions their notes (e.g. "in my notes", "v mojich poznámkach") — never on your own initiative. Without query it returns the newest notes; open one with get. Read-only: agents cannot write notes. Works in any project; it needs no "Memory (Tabula)" section.`,

  save_thought: `Save a new thought to the user's personal notebook in Tabula ("Thoughts"), which belongs to no project and never appears in recall. Call it ONLY when the user explicitly asks to save something to Tabula (e.g. "save this to Tabula", "ulož mi to do tabule") — never on your own initiative.
Call find_thoughts first; if a thought on the same topic exists, tell the user and use update_thought instead of creating a duplicate.
Write it so the user can reread it months later without the conversation: a specific title; a Markdown body with the key ideas, conclusions, reasons and open questions in the user's language; no chat transcript and no filler. Never store secrets.`,

  update_thought: `Change an existing thought in the user's Tabula notebook when the user asks to add to it or fix it. Use append to add a section at the end; use body only to rewrite the whole text. The previous version is always kept and the user can restore it.
expected_version (from find_thoughts or get) is REQUIRED when you pass body or title, so you never overwrite the user's own edit; append alone may omit it; on a 409 conflict call get and apply the change again.`,

  find_thoughts: `List or search the user's personal Tabula notebook ("Thoughts"). Without query it returns the newest thoughts. Use it when the user refers to something saved earlier, and before save_thought to avoid duplicates. Returns ids and versions for get and update_thought. Works in any project; it needs no "Memory (Tabula)" section.`,
} as const;

export const TOOL_DESCRIPTIONS = {
  list_projects: `List Tabula projects: slug, one-line description, number of synced files and of active memories (global rules live in "global").
Call it when you are unsure which project slug to use. Never invent a slug; projects are created by the human or, on the user's explicit request, by setup_project.`,

  recall: `Call at the start of a session when the project's CLAUDE.md (or project instructions) names a Tabula project. Returns the global rules (follow them), the project state (the content of its handoff state files) and the list of the project's synced files. Pass include_state: false only where the \`tabula\` command restored the files to disk (Claude Code on a computer with the repository); in Claude Code on the web and in claude.ai keep the default (true). Without such a section do not call it, and never guess a slug.`,

  search: `Full-text search over the global rules and the project's synced files (path and content). Use it when you need something specific that recall did not show; open a file hit with read_file. Words match exactly; use "quoted phrases", OR and -exclusion.`,

  get: `Fetch the full text of one global rule (memory), note, thought or bug report by id (for a report's attachments use get_report). Notes are the user's own notebook: read them only when the user mentions their notes.`,

  remember: `Store a global rule — something that applies to every project. Call it ONLY when the user explicitly asks to add a global rule, never on your own initiative and never for project knowledge (that belongs in the repository or in its synced files). project must be "global".
Always search first; if a rule covers the same topic, pass its id as supersedes_id instead of creating a duplicate.
Title: one line, imperative for rules ("Run tests via pnpm test:unit"). Body: the why and the context in 1–5 sentences. Never store secrets (passwords, keys, tokens).`,

  deprecate: `Mark a global rule as no longer valid, with a reason — only when the user asks. You cannot deprecate human-authored records or notes.`,

  setup_project: `Onboard a project into Tabula. Call it ONLY when the user explicitly asks to start using Tabula in this project — never on your own initiative. Slug = the project folder name in lowercase (letters, digits, dashes). Creates the project if it does not exist yet (name defaults to the slug; give a one-sentence description of the project) and returns the "Memory (Tabula)" section for the project's CLAUDE.md and a suggested .tabula.json for the repository root (which untracked files the tabula command syncs; without "project" it uses the folder name), plus the next step: run \`tabula status\` before the first \`tabula push\`. If the project already exists it is left unchanged and both are returned again.`,

  list_files: `List the files synced into a Tabula project — the untracked files of its repository (handoff state, private specs and plans): path, size, version, sha256, date, and whether the file is part of the project state. Read one with read_file.`,

  read_file: `Read one synced file of a project (path exactly as list_files shows it). The reply has separate text blocks: first a header line "[file <path> · version <n> · sha256 <hex> · <n> characters]" (not part of the file), then the file's text exactly as stored, and for long files a last block naming the offset to pass next (parts of 100 000 characters). Pass the header's sha256 as base_sha256 to write_file or delete_file. Where the \`tabula\` command restored the files to disk, prefer the copy on disk.`,

  write_file: `Save a new or changed synced file of a project (spec, plan, progress.md, handoff state) when the \`tabula\` command is not available — Claude Code on the web, claude.ai. On a computer with the repository edit the file on disk and run \`tabula push\` instead. The path must match the project's sync patterns (the "sync" list of its .tabula.json, which the server learns from \`tabula push\`); .env files are refused. Never write files that git tracks in the repository: only the untracked synced files belong here. content is the whole new text (UTF-8, at most 1 MiB).
A new file needs no base_sha256. To change an existing file, read it first with read_file and pass the sha256 from its header as base_sha256: a missing base is refused, and if the file changed meanwhile you get a 409 with the current sha256 — read it again, apply your change to that text and retry; never overwrite blindly. Files matching the "state" patterns become the project state. Returns path, sha256, version, changed, state. The last 20 versions are kept; the user's computers get the file with \`tabula pull\`.`,

  delete_file: `Delete a synced file of a project when the user asks to and the \`tabula\` command is not available (on a computer: \`tabula rm\`). base_sha256 must be the sha256 of the current version (from list_files or the read_file header). The delete is reversible in the Tabula UI; copies on the user's computers are kept.`,

  find_notes: `List or search the user's own notes (Tabula "Notes", a personal notebook outside projects). Call it ONLY when the user mentions their notes (e.g. "in my notes", "v mojich poznámkach") — never on your own initiative. Without query it returns the newest notes; open one with get. Read-only: agents cannot write notes. Works in any project; it needs no "Memory (Tabula)" section.`,

  save_thought: `Save a new thought to the user's personal notebook in Tabula ("Thoughts"), which belongs to no project and never appears in recall. Call it ONLY when the user explicitly asks to save something to Tabula (e.g. "save this to Tabula", "ulož mi to do tabule") — never on your own initiative.
Call find_thoughts first; if a thought on the same topic exists, tell the user and use update_thought instead of creating a duplicate.
Write it so the user can reread it months later without the conversation: a specific title; a Markdown body with the key ideas, conclusions, reasons and open questions in the user's language; no chat transcript and no filler. Never store secrets.`,

  update_thought: `Change an existing thought in the user's Tabula notebook when the user asks to add to it or fix it. Use append to add a section at the end; use body only to rewrite the whole text. The previous version is always kept and the user can restore it.
expected_version (from find_thoughts or get) is REQUIRED when you pass body or title, so you never overwrite the user's own edit; append alone may omit it; on a 409 conflict call get and apply the change again.`,

  find_thoughts: `List or search the user's personal Tabula notebook ("Thoughts"). Without query it returns the newest thoughts. Use it when the user refers to something saved earlier, and before save_thought to avoid duplicates. Returns ids and versions for get and update_thought. Works in any project; it needs no "Memory (Tabula)" section.`,

  list_reports: `List bug reports of a project (or of all projects): id, title, status, attachment counts. By default only open ones (status new or triaged). Bug reports are captured by the user on the phone — text, photos, screen recordings and voice notes — and wait for an agent to turn them into tasks. Use it when the user asks about bug reports ("hlásenia", "bugy") or asks you to process them.`,

  get_report: `Read one bug report: the user's description, the triage written so far, and its attachments (photos, videos, audio, saved frames) with durations and download links valid for 24 hours. Look at photos and frames with view_attachment; for a moment in a video use get_frame. The links also work with curl if you prefer to process a file locally.`,

  create_report: `Create a bug report for a project when the user asks you to record a bug (e.g. "zapíš bug do Tabuly pre music-creator"). Title: what is broken, one line. description: the user's words and the steps to reproduce. Files are added by the user in the Tabula app. project is the slug from list_projects; never guess it.`,

  update_report: `Write your analysis of a bug report: pass triage (Markdown) with what is wrong, where in the code, and a checklist of tasks; or append_triage to add to it. Set status "triaged" once the tasks are written. Set "done" only when the user confirms the fix or asks you to close it — closing deletes the report's video and audio after a grace period (photos, frames and text stay).
expected_version (from get_report) is REQUIRED when you replace triage or title or set status "done"; append_triage and status "triaged" may be sent without it. On a 409 conflict call get_report and apply the change again.`,

  view_attachment: `Look at a photo or a saved frame of a bug report (returned as an image). For a video use get_frame with a moment; audio cannot be viewed.`,

  get_frame: `Take a still from a report's video at a given moment ("2:41", "1:02:03" or seconds, e.g. 161.5) and look at it. The frame is saved to the report, so it stays after the video is deleted; asking again for the same moment returns the saved one. Use it for the moments that matter — when the user says "here", "look", or describes what the screen shows — rather than sampling the whole video.`,
} as const;

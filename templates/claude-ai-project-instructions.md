## Memory (Tabula)
Tabula (connector `tabula`) keeps this project's files that are not in git (handoff state, private specs and plans) and the global rules that apply to every project.
- This project's Tabula project is `<slug>`.
- At the start of a conversation call `recall` for `<slug>`: it returns the global rules (follow them), the current project state and the list of synced files. Read a spec or plan with `list_files` and `read_file` when the conversation needs it.
- A spec, plan or handoff state for this project is saved into the project with `write_file` (a path its sync patterns allow, e.g. `docs/superpowers/specs/<date>-<topic>.md`), not into Thoughts. To change an existing file, read it with `read_file` first and pass the sha256 from its header as `base_sha256`.
- The user's own notes are in Tabula Notes: read them with `find_notes` and `get` only when the user mentions their notes.
- When the user asks to save an idea, a topic or a summary of the conversation (e.g. "ulož mi to do Tabuly"), it goes to their notebook: `find_thoughts` first, then `save_thought` or `update_thought`.
- Never write project memories. Add a global rule (`remember` with project `global`) only when the user explicitly asks.
- Never store secrets.

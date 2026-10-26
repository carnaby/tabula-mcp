## Memory (Tabula)
Tabula (connector `tabula`) keeps this project's files that are not in git (handoff state, private specs and plans) and the global rules that apply to every project.
- This project's Tabula project is `<slug>`.
- At the start of a conversation call `recall` for `<slug>`: it returns the global rules (follow them), the current project state and the list of synced files. Read a spec or plan with `list_files` and `read_file` when the conversation needs it.
- The user's own notes are in Tabula Notes: read them with `find_notes` and `get` only when the user mentions their notes.
- When the user asks to save an idea, a topic or a summary of the conversation (e.g. "ulož mi to do Tabuly"), it goes to their notebook: `find_thoughts` first, then `save_thought` or `update_thought`.
- Never write project memories. Add a global rule (`remember` with project `global`) only when the user explicitly asks.
- Never store secrets.

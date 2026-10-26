## Memory (Tabula)
Tabula keeps this project's files that are not in git (handoff state, private specs and plans) and the global rules that apply to every project.
- This project's Tabula project is `<slug>`; `.tabula.json` says which untracked files are synced.
- At session start call `recall` for `<slug>` with `include_state: false` and follow the global rules. The project state is on disk (restored by the SessionStart hook).
- At handoff run `tabula push` after writing the state file.
- Never write project memories. Add a global rule only when the user explicitly asks.

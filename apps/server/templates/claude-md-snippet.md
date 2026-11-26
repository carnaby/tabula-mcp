## Handoff state (read at session start)
- Handoff state (gitignored, kept in Tabula): `docs/handoff/<slug>-agent.md`
- Agent knowledge (kept in Tabula unless committed): `docs/agents/<slug>-agent.md`

The last session's handoff is imported below. Read it before answering anything, continue where it says to pick up, and check its verified state against reality before relying on it.

@docs/handoff/<slug>-agent.md

If the import above is empty (Claude Code on the web, a fresh clone), the file is not on disk: before anything else call `recall` for `<slug>` with `include_state: true`, which returns it.

## Memory (Tabula)
Tabula keeps this project's files that are not in git (handoff state, private specs and plans) and the global rules that apply to every project. This project's Tabula project is `<slug>`; `.tabula.json` says which untracked files are synced.
- At session start call `recall` for `<slug>` and follow the global rules. With the files on disk (the SessionStart hook ran `tabula pull`) pass `include_state: false`.
- Without the `tabula` command (Claude Code on the web, claude.ai): read synced files with `read_file` and save every new or changed one (spec, plan, `progress.md`, handoff state) with `write_file`.
- At handoff run `tabula push` after writing the state file.
- Never write project memories. Add a global rule only when the user explicitly asks.

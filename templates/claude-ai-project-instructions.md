## Memory (Tabula)
Tabula (connector `tabula`) is a backup memory shared with Claude Code on other machines. It ranks below the code and this project's own documents: on a conflict they win, and the Tabula record gets fixed.
- This project's Tabula project is `<slug>`.
- At the start of a conversation call `recall` for `<slug>` and follow its rules and gotchas. A record older than what it describes is suspect — check it.
- Write memories only when the user asks to remember something for this project (e.g. "zapamätaj si to pre projekt"): 0–3 records of rules, decisions, facts or traps a future session must know. `search` first; replace an outdated record with `remember` + `supersedes_id`, `deprecate` one that no longer holds.
- When the user asks to save an idea, a topic or a summary of the conversation (e.g. "ulož mi to do Tabuly"), it goes to their personal notebook, not to the project: `find_thoughts` first, then `save_thought` or `update_thought`.
- Never store secrets, task progress or TODOs.

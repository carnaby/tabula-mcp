/** Single source of the CLAUDE.md section; templates/claude-md-snippet.md must stay identical (see test). */
export function claudeMdSection(slug: string): string {
  return `## Memory (Tabula)
Tabula keeps this project's files that are not in git (handoff state, private specs and plans) and the global rules that apply to every project.
- This project's Tabula project is \`${slug}\`; \`.tabula.json\` says which untracked files are synced.
- At session start call \`recall\` for \`${slug}\` with \`include_state: false\` and follow the global rules. The project state is on disk (restored by the SessionStart hook).
- At handoff run \`tabula push\` after writing the state file.
- Never write project memories. Add a global rule only when the user explicitly asks.
`;
}

/** The .tabula.json that setup_project and the Setup tab suggest; without "project" the CLI uses the folder name. */
export const TABULA_JSON = `{
  "sync": ["docs/**", ".superpowers/sdd/*/progress.md"],
  "state": ["docs/handoff/*.md"]
}
`;

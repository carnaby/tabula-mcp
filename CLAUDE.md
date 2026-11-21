# Tabula

Self-hosted MCP memory server (Node 22, TypeScript, Fastify, Postgres, React). See README.md. pnpm workspace with Nx: `apps/server`, `apps/web`, `apps/cli`, `packages/shared`. Commands from the root: `pnpm typecheck`, `pnpm test` (Docker), `pnpm build`, `pnpm affected`; one test file: `pnpm --filter @tabula/server exec vitest run test/…` (after one `pnpm build` on a fresh clone). The repository is public: no host-specific details in code, tests or docs; comments in English.

## Session start (do this first)
At the start of every new session, before answering anything else, read your own latest handoff in `docs/handoff/` (the orchestrator's is `docs/handoff/agent-orchestrator.md`; the file written at the last handoff) and continue where its "Pokračuj tu" section says. Do not wait for the user to ask for it.

## Memory (Tabula)
Tabula keeps this project's files that are not in git (handoff state, private specs and plans) and the global rules that apply to every project.
- This project's Tabula project is `tabula`; `.tabula.json` says which untracked files are synced.
- At session start call `recall` for `tabula` with `include_state: false` and follow the global rules. The project state is on disk (restored by the SessionStart hook), so the handoff file from "Session start" is already there.
- At handoff run `tabula push` after writing the state file.
- If the `tabula` command is not available (Claude Code on the web, claude.ai), the files are not on disk: call `recall` with `include_state: true`, read files with `read_file`, and save every new or changed synced file (spec, plan, `progress.md`, handoff state) with `write_file`.
- Never write project memories. Add a global rule only when the user explicitly asks.

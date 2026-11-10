# Tabula

**A small, self-hosted memory for AI agents, served over MCP.**

An AI coding agent starts every session with an empty head. Most of what it needs is in the repository: the code, `CLAUDE.md`, the docs in git. Some of it is not. Handoff notes that say where the last session stopped, specs and plans that must stay out of a public repository, the progress log of a running plan — they are gitignored on purpose, so a fresh clone or another computer doesn't have them, and claude.ai never sees them.

Tabula (Latin for *writing tablet*) keeps exactly that. It is one small server with a Postgres database, an MCP endpoint for agents ([Model Context Protocol](https://modelcontextprotocol.io)), a REST API and a web UI:

- **Project files** — a repository's untracked files (handoff state, private specs and plans), mirrored by a dependency-free `tabula` command. A session-start hook restores them in a fresh clone, `tabula push` at handoff saves them, and claude.ai reads them through MCP.
- **Global rules** — the few rules that apply to every project. You write them in the UI; agents add one only when you explicitly ask.
- **Notes** — your own notebook. Agents read it only when you mention your notes.
- **Thoughts** — a notebook of things worth keeping from chats: say *"save this to Tabula"* in claude.ai and it lands there.

It is deliberately modest: no embeddings, no automatic memory, and no second copy of what git or the agent's own local memory already hold.

## How it works

### What it stores

| | Written by | Agents can | Shape |
|---|---|---|---|
| **Project file** | the `tabula` command, from the repository; agents without it (Claude Code on the web, claude.ai) with `write_file` | list, read, search; write and delete paths the project's `sync` patterns allow | UTF-8 text ≤ 1 MiB at a repository-relative path; the last 20 versions are kept; deleting is reversible |
| **Global rule** | you; agents only on request | read; add or retire one on explicit request | `kind` (rule, gotcha, fact, decision) + one-line title + body ≤ 2 000 characters |
| **Note** | you | read, when you mention your notes | Markdown with tags; pinned notes stay on top |
| **Thought** | you, and agents on request | create, edit, append | Markdown ≤ 50 000 characters with tags; every change keeps the previous version (the last 50) |

Project files and global rules feed the `recall` digest. Notes and Thoughts never do.

### The `tabula` command

`tabula` is a single ES module (`apps/cli/tabula.mjs`) without dependencies; Node 22 or newer runs it on Windows, macOS and Linux. The server hands it out at `/cli/tabula.mjs`:

```bash
# macOS / Linux
mkdir -p ~/.tabula && curl -fsSL https://tabula.example.com/cli/tabula.mjs -o ~/.tabula/tabula.mjs
node ~/.tabula/tabula.mjs install                  # shims in ~/.tabula/bin; add that folder to PATH as printed
node ~/.tabula/tabula.mjs login https://tabula.example.com   # asks for the token, saves ~/.tabula/config.json
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force "$HOME\.tabula" | Out-Null
Invoke-WebRequest https://tabula.example.com/cli/tabula.mjs -OutFile "$HOME\.tabula\tabula.mjs"
node "$HOME\.tabula\tabula.mjs" install
node "$HOME\.tabula\tabula.mjs" login https://tabula.example.com
```

Once `~/.tabula/bin` is on your `PATH`, plain `tabula …` works.

A repository opts in with a `.tabula.json` in its root, committed:

```json
{
  "sync": ["docs/**", ".superpowers/sdd/*/progress.md"],
  "state": ["docs/handoff/*.md"]
}
```

- `project` (optional) names the Tabula project; by default it is the name of the working-tree folder, so a git worktree for a side series syncs into its own project with the same file.
- `sync` lists glob patterns (`**`, `*`, `?`). Only files git does **not** track are candidates — untracked and ignored ones, never `node_modules/` or `.git/`. `.env` and `.env.*` (any letter case) are refused even when a pattern matches them, so keep the patterns explicit; binary files, invalid UTF-8 and files over 1 MiB are skipped with a warning.
- `state` lists the files that form the current project state (default: `docs/handoff/*.md` at any depth). `recall` includes their content.
- Every `tabula push` also sends the `sync` and `state` patterns to the server (`PUT /api/projects/<id>/sync-config`). `write_file` uses them, matched by the same code as the command, so an agent can write only paths this repository syncs. An older server without that endpoint gets a warning, and the push still succeeds. If the server rejects the patterns, the push warns and the previously stored patterns keep deciding what agents may write.

| Command | What it does |
|---|---|
| `tabula status` | new, changed, newer on the server, conflicts, missing here, deleted on the server |
| `tabula push [--force]` | uploads new and changed files; never deletes; warns before uploading more than 100 new files |
| `tabula pull [--force]` | writes missing files and updates unchanged copies, state files first; a file that cannot be written is reported and skipped; never deletes local files |
| `tabula rm <path>` | deletes a file on the server (restorable in the UI) |
| `tabula pull --hook` | for the SessionStart hook: silent without `.tabula.json` or a login, at most 5 seconds (when time runs out it keeps what it restored and says how many files are missing), always exit 0 |
| `tabula login <url>` · `install` · `update` | credentials (or `TABULA_URL` / `TABULA_TOKEN`), PATH shims and the hook snippet, self-update |
| `tabula worker [--once] [--log]` · `worker setup` · `worker doctor` · `worker queue [--json]` | transcribes report recordings on a PC with an NVIDIA GPU — see [Transcription worker](#transcription-worker); `--events` and `worker queue --json` are for the [tray app](#tray-app) |

Each clone keeps the hash it last synced for every file in `<git-dir>/tabula-sync.json` (per worktree, never committed). The server accepts a change only if it is based on the server's current version, so two machines editing the same file produce a **conflict** instead of a silent overwrite: merge by hand, or take one side with `--force`. Exit codes: 0 OK, 1 error, 2 finished with conflicts.

To restore the files at the start of every Claude Code session, add the hook from [`apps/server/templates/session-start-hook.json`](apps/server/templates/session-start-hook.json) to `~/.claude/settings.json`:

```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "node ~/.tabula/tabula.mjs pull --hook", "timeout": 10 } ] } ] } }
```

On Windows use the absolute path that `tabula install` prints, e.g. `node "C:/Users/<you>/.tabula/tabula.mjs" pull --hook`.

### Transcription worker

Voice notes, screen recordings and recordings of meetings in reports are transcribed with timestamps, so an agent reads "[2:41] here the button stops responding" and asks `get_frame` for exactly that moment. Tabula itself runs on small hardware without a GPU, so the work is done by **`tabula worker`** on a computer with an NVIDIA GPU. The worker pulls jobs from Tabula over HTTPS — nothing connects to that computer — and while it is off, jobs wait in the queue. Recordings travel only between your own machines; no third-party service is involved.

Requirements on that computer: an NVIDIA GPU with a current driver (RTX 50xx cards need a driver with CUDA 12.8 or newer), Python 3.9 or newer (on Windows from python.org, with the `py` launcher), `ffmpeg` on `PATH` (Windows: `winget install Gyan.FFmpeg`) and the `tabula` command. No CUDA toolkit is needed: the CUDA libraries come as pip packages.

1. On the server set `TABULA_WORKER_TOKEN` (at least 32 characters, e.g. `openssl rand -hex 32`, different from `TABULA_TOKEN`) and restart Tabula. This token opens only `/api/worker/*`. The worker does not use `TABULA_TOKEN` at all: it uses only its own worker token, which opens nothing but `/api/worker/*`. Without `TABULA_WORKER_TOKEN` recordings are still queued, but the app and the agent tools say "Transcription is not enabled on this server" (instead of asking you to start a worker) until you set it.
2. On the GPU computer:

   ```powershell
   tabula worker setup https://tabula.example.com   # asks for the worker token, creates the Python environment, installs faster-whisper
   tabula worker doctor                             # checks ffmpeg, Python, CUDA and the GPU, then transcribes a 5 s sample
   ```

   `setup` checks the token first, then creates a virtual environment in `%LOCALAPPDATA%\tabula\whisper\venv` (`$XDG_DATA_HOME/tabula/whisper/venv`, by default `~/.local/share/tabula/whisper/venv`, outside Windows) and installs `faster-whisper>=1.2.1,<2`, `ctranslate2>=4.8.4,<5`, `nvidia-cublas-cu12>=12.9,<13` and `nvidia-cudnn-cu12>=9,<10` into it. It puts `transcribe.py` into the `whisper` folder next to the environment (`%LOCALAPPDATA%\tabula\whisper\transcribe.py`) and saves the settings in the `worker` section of `~/.tabula/config.json`. The first transcription downloads the Whisper model (`large-v3`, about 3 GB) into the Hugging Face cache.

   `setup` reuses a worker token stored for the same URL and never takes `TABULA_WORKER_TOKEN` from the environment: without a stored token it asks for one, or reads it from standard input with `--token-stdin` (for scripts).

| Command | What it does |
|---|---|
| `tabula worker` | waits for jobs and transcribes them until Ctrl+C (a job in progress goes back to the queue) |
| `tabula worker --once` | transcribes what is queued, then exits |
| `tabula worker --log` | logs to `%LOCALAPPDATA%\tabula\worker.log` instead of the console (for the Task Scheduler) |
| `tabula worker [--once] --events` | for the tray app: JSON events on stdout (one per line), `stop` on stdin, logs to `worker.log` |
| `tabula worker queue [--json]` | how many recordings wait on the server and when this computer's worker was last seen (asking does not count as being seen) |
| `tabula worker setup [<url>] [--token-stdin] [--diarize]` | creates or updates the Python environment and saves the worker token; `--diarize` also sets up speaker recognition |
| `tabula worker doctor` | checks the whole chain and says what to fix |

Each job runs in its own Python process, which loads the model and exits, so a waiting worker holds no GPU memory and the GPU stays free for games and 3D work. There is no fallback to the CPU: without CUDA the worker gives the job back and stops, and `doctor` says why.

The settings in `~/.tabula/config.json` (`setup` writes them; edit what you want to change):

```json
{
  "worker": {
    "url": "https://tabula.example.com",
    "token": "<TABULA_WORKER_TOKEN>",
    "model": "large-v3",
    "language": "sk",
    "device": "cuda",
    "compute_type": "float16",
    "beam_size": 5,
    "initial_prompt": "Tabula, bug report, Fastify, Drizzle",
    "ffmpeg": "ffmpeg"
  }
}
```

`setup` also writes `python` (the environment's interpreter) and `script` (`transcribe.py`); leave them as they are.

- `model`: `large-v3`, or `large-v3-turbo` (faster, nearly as good).
- `language`: a language code, or `auto` to detect it for each recording.
- `initial_prompt`: names of your projects and technical words, so Whisper spells them right; the worker adds the report's project to it on every job (a report without a project adds nothing).
- `diarize`: written by `setup --diarize`; remove it to turn speaker recognition off.
- `ffmpeg`: the program to run, if it is not on `PATH` (a full path works).
- `TABULA_WORKER_TOKEN` and `TABULA_URL` in the environment override the saved values; `TABULA_DATA_DIR` moves the data folder.

The log shows job ids, sizes, lengths, times, project (or `no project`) and report title — never tokens or what was said. With speaker recognition it also logs how many speakers were found. A job that fails is offered again after 1 and after 4 minutes; after the third failure the report shows it as failed with *Try again*. If the computer sleeps or the worker stops in the middle of a job, its 10-minute lease runs out and the job goes back to the queue. Transcripts stay when the recording is deleted after the report is closed, and search finds their words. Reports without a project need `tabula` 1.4.1 for a clean log and tray display (`tabula update`); older versions transcribe them as well.

#### Speaker recognition (optional)

When a recording catches a conversation — one person asks while another shows the app — the transcript can say who speaks on each line. A second model, [pyannote](https://github.com/pyannote/pyannote-audio) `speaker-diarization-community-1`, finds the voices (`S1`, `S2` … numbered by who speaks first; it works out how many there are by itself) and the worker joins its result with Whisper's word times. You give the speakers names in the app with a click, or Claude does when the content makes it clear (`name_speakers`). It runs on the GPU only, after Whisper has finished, in its own Python environment (about 5 GB, mostly PyTorch with CUDA).

```powershell
tabula worker setup https://tabula.example.com --diarize
tabula worker doctor
```

`--diarize` does the usual setup first, then creates `%LOCALAPPDATA%\tabula\diarize\venv` (Python 3.10 or newer), installs `pyannote.audio>=4.0.7,<5` with `torch==2.11.0`, `torchaudio==2.11.0` and `torchcodec==0.17.0`, and then — last, because pyannote's dependencies bring the CPU build — the CUDA 12.8 build of PyTorch from `https://download.pytorch.org/whl/cu128`. It puts `diarize.py` next to the environment and saves `"diarize": { "python": …, "script": … }` in the `worker` section of `config.json` once the model runs on the GPU. Without that entry the worker transcribes as before.

The model is free but gated: Hugging Face hands it out after you accept its conditions once. `setup` stops and says so when it cannot download it:

1. Sign in at [huggingface.co](https://huggingface.co) (a free account is enough).
2. Open [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) and accept the conditions.
3. Create a token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens): type *Read* (or *Fine-grained* with "Read access to contents of all public gated repos you can access").
4. Save it with the `hf` command of the new environment, e.g. `& "$env:LOCALAPPDATA\tabula\diarize\venv\Scripts\hf.exe" auth login`. The token stays in the Hugging Face cache (`~/.cache/huggingface/token`); Tabula never reads, prints or stores it.
5. Run `tabula worker setup --diarize` again.

The model is downloaded once; jobs then run offline from the cache, and pyannote's usage metrics are turned off. `doctor` checks the environment, that PyTorch sees the GPU, the token and the cached model, then recognizes the speakers of a 5 s sample. If speaker recognition fails for a recording (no GPU memory, a broken environment), the transcript is still delivered and the report says "Speakers not recognized: …". No voice prints are kept: speakers are only told apart within one recording.

#### Starting the worker automatically (Windows)

The [tray app](#tray-app) does this with a click and shows what the worker does; the Task Scheduler below remains an alternative without it.

Usually you start the worker when you need it — `tabula worker --once` — and the report page reminds you when a recording waits and shows when the worker was last seen. To run it in the background whenever you sign in, create a task in PowerShell (creating a task that starts at sign-in needs a PowerShell opened with *Run as administrator*; the task still runs as you):

```powershell
$node = (Get-Command node).Source
$cli = "$HOME\.tabula\tabula.mjs"
schtasks /Create /TN "Tabula worker" /SC ONLOGON /IT /RL LIMITED /F /TR "powershell.exe -NoProfile -WindowStyle Hidden -Command & '$node' '$cli' worker --log"
```

At sign-in a console window may flash briefly; the worker itself then runs without a window.

| To … | Run |
|---|---|
| start it now | `schtasks /Run /TN "Tabula worker"` |
| stop it (a job in progress returns to the queue within 10 minutes) | `schtasks /End /TN "Tabula worker"` |
| keep the task but stop starting it at sign-in | `schtasks /Change /TN "Tabula worker" /DISABLE` (`/ENABLE` turns it back on) |
| remove it | `schtasks /Delete /TN "Tabula worker" /F` |
| watch the log | `Get-Content "$env:LOCALAPPDATA\tabula\worker.log" -Tail 20 -Wait` |

The Task Scheduler stops a task after 3 days by default; to keep the worker running longer, open *Task Scheduler → Tabula worker → Settings* and clear *Stop the task if it runs longer than*.

#### Tray app

The **Tabula tray** app (Windows; Ubuntu builds too) puts the worker next to the clock: its icon shows whether the worker runs, what it transcribes and whether a recording waits on the server. One click transcribes what is queued, or starts the worker until you stop it. The tray runs `tabula worker` for you; the URL and the worker token stay with the CLI (`tabula worker setup`), the tray never reads them.

Install:

1. Set up the worker first (`tabula worker setup`, `tabula worker doctor`, above). The tray needs `tabula` 1.3.0 or newer: `tabula update` (it also refreshes `transcribe.py` and `diarize.py`). With speaker recognition use a tray from this version on: it shows the step as *Recognizing speakers*; an older tray logs that step as an ignored line.
2. Download the installer from the repository's Releases (tags `tray-v…`): the `.msi` for Windows, the `.deb` or the `.AppImage` for Ubuntu. The installers are not signed: the first time Windows SmartScreen says "Windows protected your PC" — choose *More info* → *Run anyway*. A tray started by the installer restarts itself once, because it would inherit the installer's Redirection Guard, under which programs behind folder links, such as scoop's, do not start.

| Icon | Means |
|---|---|
| grey | the worker is stopped and nothing waits |
| grey with an orange dot | recordings wait on the server (the tooltip says how many); one notification "New recording to transcribe" says so when the first arrives — clicking it opens the window, but only while the notification is still on screen (not from the Action Center) |
| green | the worker is starting, waiting for jobs or stopping — or runs outside the tray (in a terminal, the Task Scheduler): then *Process queue*, *Start* and *Stop* are off and the tooltip says "Running outside the tray" |
| blue | transcribing; the tooltip shows the step or the progress, the project and the report |
| red | the worker stopped with an error, or the queue cannot be checked; the tooltip says why |

Right click: a status line (e.g. "2 waiting · worker stopped"), *Process queue* (`tabula worker --once`), *Start* (until you stop it), *Stop* (a job in progress goes back to the queue; while stopping it reads *Stop now* and quits at once), *Open window*, *Start Tabula tray at sign-in* (starts the tray, not the worker), *Quit* (stops the worker first and waits up to 15 s). A left click on the icon opens the window: the current job with a link to its report, the queue on the server, the last 200 log lines, *Run doctor* (only while no worker runs) and *Open log folder*. Closing the window only hides it. The worker logs to `worker.log` in the data folder, as with `--log`.

The tray runs `node` from `PATH` and the CLI at `~/.tabula/tabula.mjs`. If yours are elsewhere, say so in `tray.json` in the data folder (`%LOCALAPPDATA%\tabula\tray.json`; on Ubuntu `~/.local/share/tabula/tray.json`); both keys are optional, other keys are refused, and the file is read again at every start, so a fix needs no restart:

```json
{ "node": "C:/Program Files/nodejs/node.exe", "cli": "D:/tools/tabula/tabula.mjs" }
```

On Ubuntu the tray needs `libwebkit2gtk-4.1-0` and `libayatana-appindicator3-1` at run time (the `.deb` installs them; for the `.AppImage`: `sudo apt install libwebkit2gtk-4.1-0 libayatana-appindicator3-1`). GNOME shows tray icons with the AppIndicator extension, which Ubuntu enables by default. Linux reports no clicks on the icon, so there the menu's *Open window* is the way in.

### The recall digest

At the start of a session the agent calls `recall` once and gets plain text:

```text
# Tabula · music-creator · 2026-10-26

## Global rules (always follow)
- Start jobs that must outlive the session detached, not in Bash background mode (#00b7)
  Bash background mode belongs to the session and dies with it. …

## Global gotchas
- Python on Windows writes CRLF unless told otherwise (#3e1a)
  …

## Project state
### docs/handoff/2026-10-26-state.md (2026-10-26)
# Where we are
…

## Files (14) — 10 newest; `read_file` for the content
docs/handoff/ — 2026-10-26-state.md (10-26, 3.1 KB, state)
docs/superpowers/ — specs/2026-10-20-mixer-design.md (10-20, 18.4 KB), plans/2026-10-20-mixer.md (10-20, 31.0 KB)
…
- 4 more — `list_files`
```

- **Fixed order:** global rules → global gotchas → global facts and decisions (titles only) → project state → the file list.
- **The file list** names the 10 newest files, one line per folder, grouped like the Files tab of the UI (the first two levels of the path; root files under `/`; `.superpowers/` last), and counts the rest for `list_files`. No references: an agent needs the paths.
- **Budget of 3 000 tokens** (estimated as characters / 4). The global rules and the file list come first; the state gets the room they leave and is cut at a line break with a pointer to `read_file`. If the rules and the list alone are too long, the list collapses into a count, then facts collapse, then gotcha and rule bodies shrink to their first sentence.
- **`include_state`:** Claude Code on a computer passes `false` — the hook already restored the files on disk. Claude Code on the web and claude.ai get the state in the digest.
- **Plain text, not JSON.** The agent reads the digest rather than parsing it, and JSON would cost 30–40 % more tokens.

### MCP tools

| Tool | What it does |
|---|---|
| `recall(project, include_state?)` | The digest above. Called once at the start of a session. |
| `list_files(project)` / `read_file(project, path, offset?)` | The project's synced files with version and sha256. `read_file` answers in separate text blocks: a header line `[file <path> · tabula:<id> · version <n> · sha256 <hex> · <n> characters]`, the text exactly as stored, and for long files (parts of 100 000 characters) a last block with the next offset. |
| `write_file(project, path, content, base_sha256?)` · `delete_file(project, path, base_sha256)` | For sessions without the `tabula` command. Only paths matching the project's `sync` patterns (refused until a `tabula push` has sent them), never `.env`, never the `global` project. A new file needs no base; changing or deleting an existing one needs the sha256 of the version the agent read, a stale one is a 409 with the current sha256, and there is no force. Paths matching `state` become the project state. The writer is the agent's label. |
| `search(query, project?, kind?, include_deprecated?, limit?)` | Full-text search over the global rules and the project files (Postgres `tsvector`). Words match by their beginning and diacritics are ignored ("projekt" finds "projektom", "graficka" finds "grafická"); a query with `"quoted phrases"`, `OR` or `-exclusion` uses web-search syntax and matches whole words. |
| `get(id)` | Any record by its reference `tabula:xxxxxxxx` (or a full uuid, or the `#xxxx` id from the digest): a rule, note, thought, report, project file or attachment. The reply starts with a line saying what it is — `tabula:d86d86e7 · report · project music-creator · Video and transcript` — then the record: a file's text like `read_file`, a photo or frame as an image with its note, a recording's transcript status. |
| `remember(project="global", kind, title, body, tags?, supersedes_id?)` | Adds a global rule — only when the user explicitly asks. Any other project is refused with the reason. |
| `deprecate(id, reason)` | Retires a global rule the agent wrote. Refuses human-written records. |
| `find_notes(query?, tag?, limit?)` | Reads your Notes — only when you mention them or paste a reference. |
| `save_thought` · `update_thought` · `find_thoughts` | The Thoughts notebook, on request; edits use `expected_version` and keep the previous version. |
| `list_reports(project?, status?, query?)` · `get_report(id)` | Reports — bugs and recordings of meetings and conversations — and their attachments (photos, videos, voice notes, saved frames; a frame may carry the user's note) with links valid for 24 hours; videos and voice notes carry their transcript (`[2:41] what was said`) or its status. `project: "none"` lists the reports without a project; `get_report` shows `project` (`none` when it has none) and `keep_media`. `query` also matches transcripts. |
| `get_transcript(attachment_id, offset?)` | The whole transcript of a video or voice note in parts of 50 000 characters, with the times to pick frames from. With several speakers the lines read `[0:12] Eva: …` and a `Speakers: S1 = Eva (named by user), S2 = not named` line follows the header (`get_report` has it as `speakers`). |
| `name_speakers(attachment_id, names)` | Names speakers (`{"S2": "Tomáš"}`) when the transcript makes it clear who is who. Never replaces a name the user gave; replaces an agent's; says what it wrote and what it skipped. |
| `edit_transcript(attachment_id, edits)` | Fixes obviously misheard words (names, project names, technical terms) or a line's speaker: 1 to 50 edits `{ "at": "0:12", "from": …, "to": … }` and/or `{ "at": …, "speaker": "S2" }`. Never changes a line the user edited; says what it wrote and what it skipped and why. The transcripts the tools show stay plain: edited lines are not marked. |
| `create_report(project?, title?, description?)` · `update_report(id, triage? \| append_triage?, status?, expected_version?)` | Records a bug or a recording on request — every field optional; without a title the description's first line, or `Report 9. 11. 2026 14:32`, becomes it. Writes the triage (for a bug the cause and the tasks, for a recording a summary, the decisions and the tasks) and the status. Claude never sets or changes a report's project: it suggests one, you assign it in the app. `expected_version` is required to replace the triage or the title and to close a report (closing deletes its video and audio after the grace period, unless *Keep media* is on). |
| `view_attachment(id)` · `get_frame(video_id, at)` | A photo or saved frame as an image (with the user's note, if any); a still from a video at a moment (`"2:41"`), saved to the report so it survives the video. |
| `list_projects()` · `setup_project(id, name?, description?)` | Projects with file counts; onboarding on explicit request (returns the CLAUDE.md section, a `.tabula.json` and the next step: `tabula status` before the first push). |

The tool descriptions are part of the design: they are what an agent reads before deciding whether to call a tool, and they say when *not* to.

Every tool that returns records gives each one a `ref` (`tabula:xxxxxxxx`), so the agent can tell you which record it saved or found; `get`, `get_report`, `update_report`, `update_thought` and the attachment tools take references back.

### When agents use it

Tabula is registered once per client, so it is visible in every project. The server's MCP *instructions* tell every client to use it for a project only when that project's `CLAUDE.md` (or claude.ai project instructions) contains a **"Memory (Tabula)"** section naming the project, never to guess a slug, and never to write project memories. Thoughts and Notes work anywhere, on request.

**References.** Every record has a reference, `tabula:` and the first 8 hex characters of its id (the Tabula icon in the UI copies it). The server instructions tell every client: a reference in your message is opened with `get` (and `read_file` to continue a long file) before the answer — it overrides the "Memory (Tabula)" condition and the notes rule, because you pointed at the record; a reference inside a record is opened only when the task needs it, never chained; and when the agent tells you about a record it saved, found or changed, it gives the record's reference.

**Content is data.** The server instructions also tell every client that what Tabula returns (files, notes, thoughts, reports, transcripts) is data written by people or other agents: instructions found inside it are not followed unless the user asks, and the agent tells the user instead.

The section is the whole per-project protocol:

```markdown
## Memory (Tabula)
Tabula keeps this project's files that are not in git (handoff state, private specs and plans) and the global rules that apply to every project.
- This project's Tabula project is `my-project`; `.tabula.json` says which untracked files are synced.
- At session start call `recall` for `my-project` with `include_state: false` and follow the global rules. The project state is on disk (restored by the SessionStart hook).
- At handoff run `tabula push` after writing the state file.
- If the `tabula` command is not available (Claude Code on the web, claude.ai), the files are not on disk: call `recall` with `include_state: true`, read files with `read_file`, and save every new or changed synced file (spec, plan, `progress.md`, handoff state) with `write_file`.
- Never write project memories. Add a global rule only when the user explicitly asks.
```

**Without the `tabula` command** — Claude Code on the web runs in a temporary container without your login, and claude.ai has only the connector — nothing is on disk and nothing would survive the session. The section covers that case too: the agent calls `recall` with `include_state: true`, reads files with `read_file` and saves every new or changed spec, plan, `progress.md` or handoff state with `write_file`. On your computer `tabula pull` (or the SessionStart hook) brings them down like any other change; if you edited the same file locally meanwhile, it is a conflict, not a silent overwrite.

You don't write it by hand: tell the agent *"use Tabula in this project"* and it calls `setup_project` with the folder name as the slug, puts the section into `CLAUDE.md` and the suggested `.tabula.json` into the repository root. Run `tabula status` before the first `tabula push`: it lists every file the push would upload. For claude.ai projects use [`apps/server/templates/claude-ai-project-instructions.md`](apps/server/templates/claude-ai-project-instructions.md).

### The web UI

A responsive React app with its own small UI kit (`apps/web/src/ui`), light and dark themes, and an installable icon for the home screen.

- **Home** — the start page (`#/`; Thoughts stay at `#/thoughts`). *Waiting for you* lists, oldest first, new reports (a recording shows whether its transcript is done, waiting or running), triaged reports waiting to be fixed or closed, and failed transcriptions, with *Open* and *Copy for Claude*, *Mark done* (the same confirmation as in the report) or *Try again*. *Copy for Claude* copies your own text with `{ref}` replaced by the report's reference — `Process report {ref}.` by default; the gear next to the heading changes it, and the server keeps it for every device. *Recent activity* is a timeline by day of pushed and edited files (one row per push, opening into its files), new and changed reports, transcripts, thoughts and notes, with who did it and the reference; the last 48 hours, at most 25 rows at a time (*Show more* for older ones), with a filter. *Warnings* appear only when a project's recall had to be trimmed to fit 3 000 tokens (*State is cut off* when the state itself was cut), a project file is over half the 1 MB limit, or recordings have waited for the transcription worker for more than a day. *Projects* lists the projects by last activity with their files, open reports and a bar per day for the last 14 days of changes. The page refreshes every minute and when you come back to the window.
- **Sidebar** — *Home*, *Notebook* (Notes, Thoughts, and Reports with the number of open reports), *For agents* (Global), and the projects with their file counts, the most recently active first (files, reports and notes count). The logo leads to Home. On phones it is a drawer. Next to the logo (on phones in the top bar) a dot shows the transcription worker: green *Worker* when it is online, pulsing *Transcribing* while it works, orange *Worker offline · N waiting* when recordings wait for it, grey *Worker offline*; a click shows when it last called in, what waits, runs and failed, and how to start it. Without `TABULA_WORKER_TOKEN` it is not shown.
- **Thoughts** and **Notes** — card grids with search, tag chips, sort and pinning; a Markdown editor with Write / Split / Preview and Ctrl/⌘ S. Thoughts also keep a version history and warn when an agent changed the text while you were typing.
- **Global** — the rules table (kind, author, status, prefix search; edit, retire, supersede) and the recall preview.
- **Project** — **State** (the state files rendered as Markdown), **Files** (list, preview, the last 20 versions with restore, delete and restore), **Recall preview** (the exact digest with a budget meter) and **Setup** (the CLAUDE.md section, a `.tabula.json`, the install commands and the hook).
- **Reports** — bugs captured on the phone while testing, and recordings of meetings, answers and conversations. No field is required: *Title*, *Description* and *Project* ("No project" is the first choice) can be filled in now or later; an empty title becomes the description's first line, or `Report <date and time>` (the browser's local time; a report Claude creates without a title gets the server's time zone, `TZ`). Add photos, screen recordings (from the gallery, or *Record screen* on a desktop) and voice notes; uploads start at once and show their progress. While a video is paused, *Save frame* keeps that moment as a picture; select a saved frame to play from there, add a note ("what the video doesn't say") or delete it. The transcript follows playback. An agent writes the **triage** (for a bug the cause and tasks, for a recording a summary, decisions and tasks) into the report; it shows up when you come back to the window. The list filters by *All projects / No project / <project>*, and each project has a *Reports* tab. *Keep media* keeps a report's video and audio after it is closed (off by default; turning it off once the grace period is over deletes them within 15 minutes). Videos and voice notes get a transcript with clickable times once the transcription worker has processed them (see below). Hover a line (on a phone, tap its text) and click the pencil to correct it: Enter saves, Esc cancels, and with several speakers you can also change who speaks. A corrected line shows a small pencil (*Edited by you* / *Edited by Claude*; Claude's also has a dashed underline), and *Restore original* brings back the worker's text; Claude never changes a line you edited. With speaker recognition each change of speaker shows a coloured label (`S1`, or the name); click it to name the speaker, with the names used before in the report and the project as suggestions. A name Claude gave has a dashed outline and *suggested by Claude* until you confirm it. *⋯ → Transcribe again* sends an open report's recording to the worker once more (the names and the corrected lines are replaced, since a new run may number the speakers differently).
- **Search** (Ctrl/⌘ K) — global rules, project files, notes, thoughts and reports at once; words match as prefixes and diacritics are ignored. A pasted reference (`tabula:d86d86e7`) opens its record directly — a rule in its dialog, an attachment inside its report (a frame selected, the video at its moment); a shorter one (`tabula:d86d`) lists what it matches to pick from.
- **References** — the Tabula icon in an editor's bar, a rule's dialog, a file and every attachment or frame copies the record's reference. Paste it into a chat with Claude and Claude opens exactly that record.

**Install it as an app.** Tabula is a PWA: in Chrome or Edge use *Install app* in the sidebar (or the install icon in the address bar); on iPhone use Share → *Add to Home Screen*. A service worker caches only the app shell and the hashed build assets — `/api` and `/mcp` always go to the network, so data is never stale and the token never ends up in a cache. Installation needs HTTPS (or `localhost`).

Lists refresh when the window regains focus, so what an agent or another machine wrote meanwhile shows up. The UI asks once for the bearer token and keeps it in `localStorage`.

## Architecture

```mermaid
flowchart LR
  CC[Claude Code] -->|MCP over HTTP| T[Tabula server]
  CA[claude.ai connector] -->|MCP over HTTP| T
  UI[Web UI] -->|REST /api| T
  CLI[tabula command] -->|REST /api| T
  T --> PG[(Postgres 17 + full-text search)]
```

One Node.js process serves everything: the MCP endpoint (`/mcp`), the REST API for the UI and the CLI (`/api`), the CLI download (`/cli/tabula.mjs`, `/cli/version`), the static UI build and `/healthz`.

- **Node 22, TypeScript, Fastify 5.** Domain logic (including project files with optimistic locking) lives in `apps/server/src/domain` and is shared by the MCP tools and the REST API; `apps/server/src/agent` adds the rules that apply only to agents (source tagging, read-only human records).
- **MCP TypeScript SDK v2**, Streamable HTTP in **stateless** mode: every request gets a fresh server instance, so the process holds no session state and restarts are invisible to clients.
- **Postgres 17 with Drizzle ORM.** Search uses a generated, weighted `tsvector` column with a GIN index and the `tabula` text search configuration: `simple` (no stemming, because records mix Slovak and English and language-specific stemming would mangle one of them) with every word passed through the `unaccent` extension first, so "graficka" and "grafická" find each other while snippets keep the original text. Queries match words by their beginning. The migration creates `unaccent` (a trusted contrib extension since Postgres 13, so the database owner may create it). No embeddings: the records are short and most reads go through `recall`, not search.
- **React + Vite** UI, built into static files served by the same process.
- **Migrations run automatically** on startup.

## Getting started

### Run it with Docker Compose

```bash
git clone https://github.com/carnaby/tabula-mcp.git && cd tabula-mcp
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 32)
TABULA_TOKEN=$(openssl rand -hex 32)
TABULA_CONNECTOR_SECRET=$(openssl rand -hex 32)
EOF
docker compose up -d --build
curl -fsS http://localhost:3000/healthz   # {"ok":true}
```

Open `http://localhost:3000`, paste `TABULA_TOKEN`, and create your first project — or let an agent create it with `setup_project`.

CI also publishes a ready-made image, `ghcr.io/carnaby/tabula:latest` (plus a `sha-<commit>` tag per build). [`deploy/`](deploy/) holds an example production stack that pulls it and a daily `pg_dump` backup script.

For anything beyond localhost, put Tabula behind a reverse proxy that terminates TLS and bind the container to loopback: the bearer token travels in a header, and it unlocks everything Tabula holds.

The proxy must pass `X-Forwarded-Proto` (and the original `Host`, or `X-Forwarded-Host`): the attachment links that agents get from `get_report` are absolute and built from them, so without it they start with `http://`. Its request body limit must be at least `TABULA_MEDIA_MAX_MB`.

Report attachments live in `TABULA_MEDIA_DIR` (`/data/media` in the image); mount a volume or a host directory there that the container's user (uid 1000, `node`) can write, or uploads are lost with the container. If the directory is missing or not writable, Tabula still starts and everything else works: it logs an error at startup, and uploads and new video frames answer `503` until the directory is fixed.

### Upgrading from Postgres 16

Since November 2026 both compose files use Postgres 17. A data directory created by Postgres 16 does not start under 17, so an existing installation moves its data with a dump. Run the first command while the old stack is still up, and keep the dump until the new stack works:

```bash
docker compose exec -T db pg_dump -U tabula tabula > tabula-pg16.sql
docker compose down
# move the old data aside: the tabula-pg volume, or $TABULA_DATA_DIR/db with deploy/docker-compose.prod.yml
docker compose up -d db                                   # now Postgres 17, empty
docker compose exec -T db psql -U tabula -d tabula -v ON_ERROR_STOP=1 < tabula-pg16.sql
docker compose up -d                                      # the app starts on the restored data
```

Restore before the app starts: on an empty database the app would create the schema itself, and the dump would then conflict with it. To stay on 16 for now, pin `image: postgres:16-alpine` for `db` in a `docker-compose.override.yml`.

### Connect Claude Code

```bash
claude mcp add tabula --scope user --transport http https://tabula.example.com/mcp \
  --header "Authorization: Bearer <TABULA_TOKEN>" \
  --header "X-Tabula-Agent: claude-code"
```

`X-Tabula-Agent` labels what this client writes, so the UI shows which agent wrote what. Check with `claude mcp get tabula`.

### Connect claude.ai

In **Settings → Connectors → Add custom connector**, use

```text
https://tabula.example.com/mcp/<TABULA_CONNECTOR_SECRET>
```

with no authentication. Custom connectors in claude.ai can't always send a static `Authorization` header, so when `TABULA_CONNECTOR_SECRET` is set, Tabula also accepts the secret as a path segment. Treat that URL as a password. Records written this way are labelled `claude-ai`.

Then paste [`apps/server/templates/claude-ai-project-instructions.md`](apps/server/templates/claude-ai-project-instructions.md) into the instructions of a claude.ai project, with your project slug.

### Other MCP clients

Any client that speaks Streamable HTTP with the classic `initialize` handshake (protocol `2025-11-25`) works: point it at `/mcp` with the bearer header.

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string (set by Compose) |
| `TABULA_TOKEN` | yes | — | Bearer token for MCP and the UI, at least 32 characters |
| `TABULA_CONNECTOR_SECRET` | no | — | Enables `/mcp/<secret>` for clients that can't send headers, at least 32 characters |
| `TABULA_WORKER_TOKEN` | no | — | Enables the transcription worker's API (`/api/worker/*`) for `tabula worker`; at least 32 characters and different from `TABULA_TOKEN`. Without it that API answers `503` |
| `PORT` | no | `3000` | Port the server listens on |
| `HOST` | no | `0.0.0.0` | Interface to bind |
| `WEB_DIST` | no | `web/dist` | Path to the UI build (in the image `/app/web/dist`; for `pnpm dev` see `.env.example`) |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error` |
| `TABULA_MEDIA_DIR` | no | `data/media` (`/data/media` in the image; for `pnpm dev` see `.env.example`: the server runs from `apps/server`) | Where report attachments are stored; mount a volume there (writable by uid 1000 in the image) and back it up with the database |
| `TABULA_MEDIA_MAX_MB` | no | `1024` | Largest accepted upload (a reverse proxy in front needs a body limit at least this big) |
| `TABULA_MEDIA_PURGE_HOURS` | no | `24` | Video and audio of a closed report are deleted this many hours after closing (`0` = at the next check, every 15 minutes), unless the report has *Keep media* on |
| `FFMPEG_PATH` / `FFPROBE_PATH` | no | `ffmpeg` / `ffprobe` | Used for video frames, image previews for agents and durations; included in the Docker image |
| `TZ` | no | `UTC` in the image | Time zone of the default title of a report Claude or the API creates without one (`Report 9. 11. 2026 14:32`); the web form uses the browser's time. E.g. `Europe/Bratislava` |
| `POSTGRES_PASSWORD` | Compose | — | Database password used by `docker-compose.yml` |
| `TABULA_PORT` | Compose | `3000` | Host port published by `docker-compose.yml` |

## Development

The repository is a pnpm workspace with [Nx](https://nx.dev): `apps/server`, `apps/web`, `apps/cli`, `apps/tray` and `packages/shared`. Each package's `package.json` scripts are its targets; `nx.json` builds `@tabula/shared` first and caches builds, type checks and the light tests (the server's tests always run).

```bash
pnpm install                # the whole workspace, one lockfile
pnpm db:dev                 # Postgres 17 in Docker (container tabula-dev-db, port 5432)
cp .env.example .env        # then set TABULA_TOKEN (an older .env: add WEB_DIST and TABULA_MEDIA_DIR from .env.example)
pnpm dev                    # server with reload on PORT (default 3000) and the UI on http://localhost:5173
pnpm dev:server             # only the server
pnpm dev:web                # only the UI; proxies /api to TABULA_API (default http://localhost:3000)
```

Nx passes the root `.env` to every task (dev, build, test) and expands `$` in its values; the tests do not depend on it.

A `502 Bad Gateway` on `/api` in the browser means the server isn't running — usually because the database isn't. After changing `packages/shared`, restart `pnpm dev` (the server and the UI use its build).

```bash
pnpm typecheck              # every package
pnpm test                   # Vitest in every package, one at a time; the server's tests start a throwaway Postgres via Testcontainers (needs Docker)
TEST_DATABASE_URL=postgres://… pnpm test   # or use an existing throwaway database (it is wiped; the database name must contain "test", e.g. tabula_test, and must differ from DATABASE_URL)
pnpm build                  # shared, server and UI (the tray builds on its own, below)
pnpm affected               # typecheck, test and build only what changed against main
pnpm graph                  # the project graph in the browser
pnpm --filter @tabula/server exec vitest run test/unit/digest.test.ts   # one test file (run `pnpm build` once on a fresh clone: shared must be built first)
pnpm db:generate --name <name>                                          # a new migration in apps/server/drizzle
```

The tray app is the workspace package `@tabula/tray` in `apps/tray`:

```bash
pnpm --filter @tabula/tray dev     # the tray with the window on http://localhost:1420
pnpm --filter @tabula/tray test    # cargo test: the state machine, the CLI processes (needs node on PATH)
pnpm --filter @tabula/tray build   # Windows: .msi in apps/tray/src-tauri/target/release/bundle/msi/
pnpm --filter @tabula/tray icons   # after changing apps/tray/icons/tray.svg: regenerates the committed PNGs
```

Building it needs Rust 1.90 or newer; on Windows also Visual Studio 2022 Build Tools with "Desktop development with C++" (WebView2 comes with Windows 11); on Ubuntu `sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev build-essential file`. A release: raise `version` in `apps/tray/package.json`, `apps/tray/src-tauri/Cargo.toml` (and its entry in `Cargo.lock`) and `apps/tray/src-tauri/tauri.conf.json`, then push a tag `tray-v<version>`; the Tray workflow attaches the `.msi`, `.deb` and `.AppImage`.

The tests cover the domain rules, the digest builder, the REST API, the MCP endpoint through a real MCP client, and the `tabula` command end to end against a real server and temporary git repositories (git must be installed).

### Layout

```text
apps/
  server/         @tabula/server
    src/
      domain/       records, validation, search, digest builder, token estimate
      agent/        what agents may do (source tagging, read-only human records)
      mcp/          MCP server, tool descriptions, server instructions, CLAUDE.md section
      http/         Fastify app, REST API, bearer auth, static UI, the CLI download
      db/           Drizzle schema, client, migrations runner
      maintenance/  one-off data migrations run inside the container
    drizzle/      SQL migrations (generated search column, GIN indexes, the global project)
    templates/    protocol snippets for CLAUDE.md, claude.ai and the SessionStart hook
    test/         Vitest: unit, database, HTTP/MCP and end-to-end CLI tests against a real server
  web/            @tabula/web: React UI (src/ui is the UI kit)
  cli/            @tabula/cli: the tabula command (one dependency-free file, served at /cli/tabula.mjs; the server reuses its glob matcher), the worker's Python scripts, unit tests
  tray/           @tabula/tray: the tray app for tabula worker (Tauri 2: Rust core in src-tauri/, window in src/)
packages/
  shared/         @tabula/shared: pure helpers the server and the UI share (references, grouping files by folder, report titles), built to dist/
deploy/           example production stack and backup script
```

## Security

- **Never store secrets in Tabula** — not in a rule, a note, a thought or a synced file. The tool descriptions say so, and it is the reason a single shared token is acceptable for a personal deployment.
- **Synced files are the most likely way a secret reaches Tabula.** A `sync` pattern uploads every untracked file it matches, and untracked files are exactly where local credentials live. `.env` and `.env.*` (in any folder and any letter case) are always refused, but nothing else is guessed: keep the patterns explicit (`docs/**`, not `**`), run `tabula status` before the first `tabula push`, and treat a secret that was uploaded by mistake as leaked: `tabula rm` only hides the file (it and its previous versions stay in the database, restorable in the UI), so rotate the secret.
- One bearer token (and the optional connector secret) unlocks all projects, rules, notes and thoughts. Tokens are compared in constant time, and the connector secret is kept out of request logs.
- Unexpected errors are logged on the server and returned to clients as a generic message, without internals.
- **Agents write project files only over `write_file` and `delete_file`**, only at paths matching the `sync` patterns the CLI last sent for that project, and never blind: an existing file needs the hash of the version the agent read. Every version keeps its writer's label and the last 20 versions can be restored in the UI.
- The `tabula` command never uploads `.env` or `.env.*` files and the server refuses them too; paths are validated on both sides (relative, no `..`, no `.git`), and paths that differ only in letter case are never synced, so one cannot overwrite the other on Windows or macOS.
- **Report attachments** are accepted only as photos, video or audio, recognised from the file's bytes (never from the name or the client's content type), so an HTML or SVG file can't be uploaded and run on Tabula's origin. They are served from `/media/<id>` with a signed, expiring link instead of the token (`<video>` and `<img>` can't send one), with `nosniff`, a sandboxing CSP and range support. The signing key is derived from `TABULA_TOKEN`: rotating the token invalidates every link. Signatures are masked in request logs.
- **ffmpeg reads untrusted files**, so it runs with only `PATH` in its environment (never the token or the database URL), reads local files only, with the demuxer fixed by the detected type, refuses pictures over 64 megapixels, and at most two ffmpeg/ffprobe processes run at once. Its error output stays in the server log.
- **There is no total storage quota and no limit on concurrent uploads**, only `TABULA_MEDIA_MAX_MB` per file: with a single token, whoever can upload can already do everything else. Watch the free space of the media volume; video and audio of closed reports are deleted after `TABULA_MEDIA_PURGE_HOURS` unless *Keep media* is on.
- **The transcription worker has its own token**, `TABULA_WORKER_TOKEN`, valid only on `/api/worker/*` (take a job, extend its lease, hand in the transcript or the error); `TABULA_TOKEN` is refused there and the worker token is refused everywhere else, including `/mcp`. The worker downloads recordings only through the signed, expiring `/media` links that come with its jobs. `/cli/transcribe.py` is public like the CLI. The worker passes its child processes (ffmpeg, Python) an environment without `TABULA_*` variables and never logs tokens or transcript text.
- **The tray app never reads a token**: it runs the CLI, which keeps the URL and the worker token. `GET /api/worker/queue` (how many jobs wait) needs the worker token but does not count as a sign of life, so the tray's checks never make a stopped worker look alive.
- `/cli/tabula.mjs` and `/cli/version` are public: they serve the CLI from this repository and no data.
- Input is validated at the boundary: length limits, slug format, and NUL characters rejected before they reach Postgres.

## Status and roadmap

Tabula is in daily personal use with Claude Code and claude.ai: it keeps the files git doesn't and a handful of global rules. The next steps depend on what real use shows, not on a feature list:

- Markdown import/export for git-friendly backups;
- a per-session log of `recall`/`remember` calls, to see whether agents follow the protocol;
- OAuth instead of a static token, once there is more than one user.

Deliberately out of scope: embeddings and RAG, automatic expiry, automatic contradiction detection, and inheritance between projects.

## License

MIT — see [LICENSE](LICENSE).

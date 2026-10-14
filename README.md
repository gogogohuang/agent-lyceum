# agent-lyceum

[![npm version](https://img.shields.io/npm/v/agent-lyceum)](https://www.npmjs.com/package/agent-lyceum)

**English** | [繁體中文](README.zh-TW.md)

Configure and run a **team of agents** (Claude Code and/or Codex) that talk to each other through file mailboxes, each with its own persona (`AGENT.md`) and long-term memory folder. Writes are scoped: an agent can only change its own memory and outbox, never other agents' context or its own persona.

The tool keeps **its own data out of your repo**: configuration, mailboxes, logs, task memory and agent worktrees all live in one visible folder, `~/agent-lyceum-config/` (override with `AGENT_LYCEUM_HOME` or `--home`). What agents *produce* is a different matter: they edit your repo (directly when they run one at a time, or in git worktrees whose changes are brought into your working tree when they run in parallel). The only things agent-lyceum itself adds inside your repository are git bookkeeping: while a parallel run exists, `refs/agent-lyceum/<run-id>/*` snapshot refs, `agent-lyceum/<run-id>/<agent>` branches and worktree registrations under `.git`; `agent-lyceum clear` removes them. See [docs/upgrading-run-v2.md](docs/upgrading-run-v2.md) if you are coming from an older version.

```bash
npx agent-lyceum init                     # create the home + global agent library
npx agent-lyceum project add web --dir ~/code/web-app
npx agent-lyceum doctor --project web   # check config + show enforcement levels
npx agent-lyceum run --task-file spec.md  # inside the repo, the project is auto-detected
npx agent-lyceum status
```

The installed binary is `agent-lyceum`. To run the latest unreleased code straight from GitHub, use `npx github:gogogohuang/agent-lyceum <command>` instead.

Requires Node 20+, plus `claude` and/or `codex` on your `PATH` (already logged in). macOS and Linux (Linux needs `bwrap` for OS sandboxing); Windows only gets warnings.

## Commands

| Layer | Command | What it does |
|---|---|---|
| Project | `init [-y]` | Create the home and the global agent library. [details](docs/commands.md#init) |
| Project | `project add <name> --dir <repo>` | Register a project. [details](docs/commands.md#project-add) |
| Project | `project` / `project remove <name> [--purge]` | List or unregister projects. [details](docs/commands.md#project-and-project-remove) |
| Diagnose | `doctor [-p name] [--task-file f] [--resolved] [--json]` | Check config (with enforcement levels), git, the lock and runtime CLIs without running agents; `--resolved` prints every effective setting and its source. [details](docs/commands.md#doctor) |
| Diagnose | `status [-p name] [--monitor]` | Show agents, mail, the current wake-up and past runs (`--json`, `--monitor`); `--task-id` takes an id, a name or a unique prefix. [details](docs/commands.md#status) |
| Run | `run ["task"] [--task-file f] [--name n] [--agent a] [-p name]` | Give the task to the lead and run until done; `--name` names the run; with `--agent`, to one member alone. [details](docs/commands.md#run) |
| Run | `resume [run] ["follow-up"] [--task-file f] [--answer] [-p name]` | Continue an interrupted or failed run, or reopen a finished one with a follow-up; `--answer` first answers the questions it is waiting on. [details](docs/commands.md#resume) |
| Run | `clear <run> [-p name] [--dry-run] [--keep-worktrees]` / `clear --lock [run-id] --force` | Delete a run (id, name or unique prefix) with its task memory and worktrees; or remove the lock a crashed run left behind. [details](docs/commands.md#clear) |
| Run | `call <agent> ["task"] [--task-file f] [--dir d]` | Call one global agent on its own, outside any project; prints its answer. [details](docs/commands.md#call) |
| Run | `tidy [-p name] [--agent a] [--layer project\|global] [--dry-run]` | Have agents tidy their own memory (manual only; archives, never deletes). [details](docs/commands.md#tidy) |
| Run | `tidy --undo <timestamp> -p name --agent a` | Undo a tidy: move its archived files back. [details](docs/commands.md#tidy) |

`agent-lyceum --help` lists each command with a one-line summary; `agent-lyceum <command> --help` prints its full description and options.

Ctrl-C cancels a run cleanly and it can be continued with `resume` ([Stopping a run](docs/commands.md#stopping-a-run)). `run` and `resume` exit `0` only when the lead reported `completed`, `2` for partial or blocked, `1` for failed, `3` while waiting for your answers, `130` for cancelled ([Exit codes](docs/commands.md#exit-codes)). Without `-p`, the project is inferred from the current directory ([Choosing the project](docs/commands.md#choosing-the-project)).

## Running one agent on its own

Two ways to give a task to a single agent instead of the whole team. The agent works alone: it cannot mail teammates, ask you questions or edit any `AGENT.md`.

```bash
npx agent-lyceum run "tidy the form" --agent fe-member -p web   # a member of the project, as an ordinary run
npx agent-lyceum call pm "is this ready to build?" --dir ~/code/web-app   # a global agent, outside any project
```

`run --agent` has a run id and the project lock, shows in `status`, and can be resumed; the agent ends the run with its own `done` mail. `call` needs no project at all: the agent comes from `team.yaml`, works in `--dir` (default: the current directory, which must not be inside or above the agent-lyceum home), prints only its final answer on stdout, and keeps `task.md`, `log/` and `result.md` in `<home>/calls/<call-id>/`. Details: [run](docs/commands.md#run) and [call](docs/commands.md#call).

## Monitor mod (Claude Code)

`plugins/status-monitor` is a Claude Code **mod**, not an ordinary plugin: it is written against Claude Code's mod hooks API (`import type { Register } from 'claude-code'`) and runs inside the Claude Code session, where it adds toasts and a `/status-monitor` pane that poll `agent-lyceum status --json`. It needs a Claude Code build that supports mods; it does not change how agent-lyceum itself runs. It shows live run status for one or several projects.

**Load it.** Build first (`npm run build`; the mod runs `dist/cli.js`), then start a session with:

```
claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor
```

`--plugin-dir` only applies when a session starts; an already-open session must be restarted (`claude --resume --plugin-dir ...` keeps the conversation). To load it every time, add `alias claude='claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor'` to your shell rc, or, for hosts where you cannot pass a flag (desktop app, SDK), set `CLAUDE_CODE_PLUGIN_DIRS` to the mod folder. While a session is running, saving a file in the mod folder hot-reloads it.

**Use it.**
- **Toasts:** a message pops up when a run finishes, is interrupted, or an agent's wake fails (prefixed `[project]` when several are watched). Nothing to do.
- **`/status-monitor`:** type it to open (or, if already open, close) the pane. It is off at session start unless `autoOpen` is set. In the **fullscreen layout** (`"tui": "fullscreen"` in `~/.claude/settings.json`, restart the session to apply; `/tui fullscreen` does the same) from 110 terminal columns it docks on the right at half the terminal width, and tabs and **關閉** (Close) can be clicked. Otherwise it shows above the prompt; the layout is fixed when the session starts, so a session started on the main screen stays that way. Keyboard (works in both): `x` closes, `v` switches graph/text, `1`-`9` or Tab/Enter switch task, Esc returns to the prompt, running the command again also closes. It draws one block per agent, with the links between the lead and each member taken from `can_message` (`▼` the lead may write to the member, `▲` the member to the lead, `↕` both; yellow marks the latest hand-off). Each block shows what that agent is doing now, the mail it is handling and the mail queued for it as short readable sections by type (task: goal and acceptance criteria; reply: changes, verification, open items, risks; done: result and what is not done), and its wake count and output tokens. Above the graph: the run id and state, task, progress bar and checklist; below it: blocked integrations, notes and the result summary. `v` switches to the plain text list (per-runtime tokens, per-agent statistics, the last 8 wakes). Every block lists the agents it may message in a "→" line, with the latest hand-off marked "●" (this also covers member-to-member targets, which get no glyph). When the graph area is narrower than 70 columns (compared with the pane's own width, as the host reports it), the blocks stack in one column and the link glyphs are left out. Each running task is a tab, newest first; finished and interrupted runs are not listed. It refreshes with the polling interval while open.

**Configure it.** In `~/.claude/settings.json` under `pluginConfigs."status-monitor@inline"` (`options`):

| Option | Meaning | Default |
|---|---|---|
| `command` | CLI to run, split on spaces, e.g. `node /path/to/agent-lyceum/dist/cli.js` | `agent-lyceum` |
| `project` | Registered project name(s) (`-p`); comma-separate to watch several; empty infers from the session's directory | empty |
| `intervalSeconds` | How often status is polled | `1` |
| `autoOpen` | Open the pane when a session starts (it seats only from 144 columns when opened unasked) | `false` |

Changes take effect on the next session start. If the pane shows `無法取得狀態：...`, the `command` could not run (usually `dist/cli.js` was not built) or the project name is not registered.

## Layout

```
~/agent-lyceum-config/
├── team.yaml                         # global agent library
├── agents/<agent>/{AGENT.md, memory/}  # global persona + cross-project memory
├── calls/<call-id>/{task.md, log/, result.md}   # one folder per `call` (outside any project), plus .lock-<agent>
└── projects/<project>/
    ├── project.yaml                  # team, repo dir, overrides
    ├── agents/<agent>/{AGENT.md?, memory/}   # project-level persona (optional) + project memory
    ├── shared/common/COMMON.md
    ├── locks/<run-id>.json           # held while that run is active (up to dispatcher.max_concurrent_runs at once)
    └── runs/<run-id>/{task.md, log.jsonl, state.json, snapshots/, agents/, mail/{inbox,outbox}/<agent>/}
```

`team.yaml` defines reusable agents; `project.yaml` picks the team and overrides fields. Objects merge field by field, arrays (`can_message`, `owns`) are replaced. Relative paths resolve against the folder of the file they are written in; `~` is allowed.

```yaml
# project.yaml
dir: ~/code/web-app
team: { lead: lead }
dispatcher: { max_rounds: 30, max_parallel: 1, max_concurrent_runs: 1, wake_timeout_sec: 600, retry: 1, strict: false, workspace_mode: auto, log_max_bytes: 8388608 }
agents:
  lead:      { resume: true, can_message: all, can_edit_agent_md: true }
  fe-member: { runtime: codex, can_message: [lead], owns: ["src/web/**"] }
  qa-member: { can_message: [lead], owns: ["tests/**"] }
  pm:        { can_message: [lead], allow_web: fetch }   # pm may search and read pages; the others have no web tools
```

Agent fields: `runtime` (`claude-code`|`codex`; optional when `model` is recognizable: `opus`/`sonnet`/`haiku`/`claude-*` → Claude Code, `gpt-*`/`o3`/`*codex*` → Codex; precedence: project runtime > project model > global runtime > global model), `model`, `effort` (Claude Code: `low`|`medium`|`high`|`xhigh`|`max` via `--effort`; Codex: `minimal`|`low`|`medium`|`high`|`xhigh` via `model_reasoning_effort`; unset = CLI default), `agent_md`, `memory.global` / `memory.project`, `resume`, `can_message` (`all` or list; default `[lead]`, lead default `all`), `can_edit_agent_md` (default only the lead), `can_ask_user` (may send `type: ask` mail to you and pause the run for an answer; default only the lead), `allow_web` (`none`|`search`|`fetch`; what the agent may use of the web, off unless set; see "Web access" below), `owns` (repo globs).

Rules checked by `doctor`: ≥ 2 agents (the lead and one member; the template has three), the lead is a listed agent, every agent has a runtime (explicit or inferred from `model`) and an existing `AGENT.md`, `effort` is valid for the agent's runtime (warning if `runtime` contradicts a recognizable `model`), `can_message` targets exist, memory dirs don't overlap, and with `max_parallel > 1` every non-lead agent needs non-overlapping `owns` and the repo must be a git repository, and with `max_concurrent_runs > 1` the repo must be a git repository and `workspace_mode` must not be shared.

## How a run works

1. The task (text, or a copy of `--task-file` kept read-only as `runs/<id>/task.md`) becomes the first mail to the lead. Tasks ≤ 16 KB are inlined; larger ones are passed by reference. Files over 1 MB are rejected.
2. The dispatcher wakes whichever agent has unread mail with `claude -p` or `codex exec` (headless). Each wake-up is a fresh session unless `resume: true`.
3. Every wake-up prompt contains the agent's `AGENT.md`, the team protocol, `COMMON.md` (read-only, ≤ 8 KB), the `MEMORY.md` index of each memory dir, the **oldest** unread message in full (one message per wake-up; the lead instead takes a run of up to 5 `reply`/`failure` messages at once and decides on them together), and titles of the queued ones, which stay unread until their own wake-up.
4. Agents send mail by writing a Markdown file with frontmatter (`to`, `type`, `subject`) into **their own** `outbox/`. The dispatcher checks `can_message`, stamps the real sender, and moves it to the recipient's `inbox/`. Handled mail goes to `inbox/<agent>/read/`. Mailboxes belong to one run (`runs/<run-id>/mail/`), so mail never crosses runs. Runs started by older versions keep using the shared `shared/{inbox,outbox}/` mailboxes (their mail is never moved); resuming such a run shows that legacy layout.
   The body of every `task` and `reply` should carry fixed `##` headings (injected into each agent's prompt): `task` → `Goal`, `Acceptance criteria`, `Scope`, `Upstream`; `reply` → `Changes`, `Verification`, `Open items`, `Risks` (write `None` when empty; `done` is exempt). Mail missing a heading is still delivered, with a warning note prepended and a `format-warning` entry in the run log.
5. The run ends when the lead sends `type: done`, when all mailboxes are empty, or after `max_rounds` wake-ups. A `done` must declare `outcome: completed|partial|blocked|failed` in its frontmatter and carry `## Result`, `## Files`, `## Verification`, `## Not done`; `completed` also needs every `## Steps` item ticked. A `done` that breaks this is sent back to the lead (twice at most, then it is kept as `partial`). Agent-lyceum does not verify what the lead reports. A failed wake-up is retried once, then reported to the lead as a failure message (if the lead itself fails, the run aborts).

Parallelism (`max_parallel > 1`) only runs agents with disjoint `owns`, and never alongside the lead. Each non-lead agent then works in its **own git worktree** (`projects/<name>/worktrees/<run-id>/<agent>`, branch `agent-lyceum/<run-id>/<agent>`) cut from a snapshot of the repo as it is when the agent is woken (`refs/agent-lyceum/<run-id>/base-<n>`; it includes the lead's uncommitted and new, non-ignored files; your HEAD, branches and working tree are not touched). `dispatcher.workspace_mode` is `auto` (worktrees when `max_parallel > 1`), `worktree` or `shared`; `shared` cannot be combined with parallel agents. A parallel run refuses to start while the repo has uncommitted changes of yours, and when the repo is not a git repository (run sequentially instead). When a member finishes, the dispatcher commits its worktree and brings the changes into your working tree (not your index or HEAD) before the lead reads the member's mail. Every changed path is checked first: it must be inside the member's `owns` (renames and deletions included), must not be `CLAUDE.md`/`AGENTS.md`, and symlinks may not point out of the project or the member's `owns`. If a file also changed in your repo since the member's snapshot, if a check fails, or if `git apply` fails, nothing is applied: the work stays on its branch and worktree, a report and patch are written to `runs/<run-id>/integration/`, the lead is told, and the run cannot end as `completed` (it ends `blocked`). A worktree isolates files only: it cannot isolate side effects on external services, databases or the network.

### Several runs at once

By default a project runs one task at a time. Set `dispatcher.max_concurrent_runs: N` (N > 1, needs a git repository) to let up to N runs of the same project be active together; starting one more is refused and names the runs in the way. In this mode **every** run, including a run that has no parallel members and a solo `run --agent <name>`, works in its own git worktree: the lead in `projects/<name>/worktrees/<run-id>/<lead>` on branch `agent-lyceum/<run-id>/<lead>`, members in worktrees cut from the lead's. A run starts from your repo's `HEAD`, so your uncommitted changes are allowed and are **not** part of it (the start line says how many files that is). Your working tree, index and HEAD are never touched.

- **Ending:** when a run ends (done, cancelled, failed, idle or round limit), the lead's work is committed once on its branch and written as `runs/<run-id>/lead.patch`, and the run prints `git merge <branch>`. A run that stops to ask you (`waiting`) is not finished: nothing is committed and no merge hint is printed; its work stays in the lead's worktree and `resume` continues in the same one.
- **Decided at start:** a run records whether its lead works in a worktree (`lead_workspace` in its state). `resume` follows what the run was started with, not the current setting: a run started concurrent resumes in its worktree even if you lowered `max_concurrent_runs`, and a run started non-concurrent resumes non-concurrently even if you raised it. The setting only governs how many runs may be active at once and what new runs do.
- **`tidy`:** `tidy` and `tidy --undo` need the project to themselves: they are refused while any run is active, and no run can start while they run, whatever `max_concurrent_runs` is.
- **`clear`:** `clear <run-id>` refuses while the lead's branch is not merged (use `--keep-worktrees` to keep it). A lock left by a crashed run is removed with `clear --lock [run-id] [-p name] --force`; with several locks, name the run.

Known limits:

- The number of agent processes can reach `max_concurrent_runs × max_parallel`; there is no global cap.
- A lead with `can_edit_agent_md: true` edits the `CLAUDE.md`/`AGENTS.md` in its own worktree; the change reaches your repo only when you merge its branch.
- `COMMON.md` and the `AGENT.md` files are shared by all runs of the project. Each run's guard only judges what changes while its own agents are working, so an edit by one run is kept; but if two runs' wake-ups overlap in time, a change one makes while the other's agents are working can be reverted by the other.
- Two runs that edit the same file are for you to reconcile when merging; agent-lyceum never merges.

### Continuing a finished run

Every run has a **name**: made from the first line of the task (lowercase letters, digits and `-`, at most 30 characters; `task` if nothing usable is left; `-2`, `-3` on repeats), or chosen with `run --name <name>` (same characters and length; refused if the name is already used). `resume`, `clear` and `status --task-id` accept the full run id, the name, or a unique prefix of either; an ambiguous prefix lists the candidates and exits `1`, and an empty one is refused. `status` shows the name next to the id.

A finished (`done`) run can be reopened with a follow-up request: `agent-lyceum resume [run] "<follow-up>"` (or `--task-file f`). The lead gets the text as a new `task`, and the run goes on with the same run dir, task memory, sessions and lead worktree.

- **Which runs:** only a finished run can be reopened. A run that is still running is refused; a run that is not finished is refused when given text (resume it without text first). Without text nothing changes: a finished run just prints its result. Without a run, the candidates are the runs that are not running, newest first: exactly one is used, none is an error, and several are listed (in a terminal you pick one by number or name; without a terminal the command fails and lists them). A lone argument counts as follow-up text only when it cannot be a run reference (it contains whitespace or a character outside `A-Z a-z 0-9 . _ -`); a one-word follow-up needs `resume <run> "<text>"` or `--task-file`.
- **What is kept:** the follow-up is saved as `runs/<run-id>/followups/<n>.md`. Each `done` report is kept as `done-<n>.md`, and `result.md` is always the latest. `state.json` gains `name`, `reopened` and `round_floor` (all optional, so older runs still load). Unresolved blocked integrations stay; the done-contract reminders start afresh for each reopened segment.
- **Round limit:** `max_rounds` counts from the reopen: `rounds` keeps accumulating, and the limit is the rounds at reopen plus `max_rounds`.
- **The lead's branch** (runs with a lead worktree): if the branch was already merged into your `HEAD` and the lead worktree is clean and untouched since the run ended, the worktree and the branch (same name, `agent-lyceum/<run-id>/<lead>`) are re-cut from your current `HEAD`, and a line says so. Otherwise the same worktree and branch continue. If a pull request was already recorded (`pr_url`) and the branch was not re-cut, a new `open_pr: true` only pushes ("pull request updated"). If the branch was re-cut, the recorded `pr_url` is cleared (the old URL stays in the run's notes) and a new pull request is opened when asked. agent-lyceum still never merges.

### Opening a pull request

When your task asks for a pull request, the lead puts `open_pr: true` in the frontmatter of its `done` report. If the run then ends `completed` and the lead's branch has changes, agent-lyceum — not an agent — pushes `agent-lyceum/<run-id>/<lead>` to `origin` and runs `gh pr create` against the repo's default branch, using the lead's report as the description (ending with `🤖 Opened by agent-lyceum`). The run result prints the PR URL, and `state.json` records it as `pr_url`. Only the lead can ask: nobody else can send `done`, and no agent's sandbox is loosened — `git push` and `gh` run outside it, with your own credentials.

- It needs a lead branch, so it works only when the run has its own worktree (`dispatcher.max_concurrent_runs` of 2 or more). Otherwise the request is reported and skipped.
- A request that cannot be honoured (the run did not complete, no changes, no `gh`, no `origin`, push or `gh` failed) never changes how the run turned out. The run says why it was not opened and keeps the branch; when a push or `gh pr create` failed it also prints the commands to finish by hand.
- Opening a pull request publishes the lead's branch and report to `origin`. An agent that asks for one (`open_pr: true`) can therefore get anything it can read inside its sandbox onto the remote, so only ask for a pull request in a task when that is acceptable. The push and `gh pr create` run from your main repository, never inside the agent's worktree, because an agent can write that directory.
- agent-lyceum never merges and does not wait for CI or review. With `max_concurrent_runs` of 2 or more, `doctor` tells you whether `gh` and `origin` are there (it does not check that `gh` is logged in).

## Web access (`allow_web`)

By default no agent can use the web. Claude Code agents are woken in headless `dontAsk` mode, where anything not explicitly allowed is refused, so `WebSearch` and `WebFetch` are denied unless you opt in per agent with `allow_web` (in `team.yaml` or `project.yaml`; the project value wins). It only decides whether the agent may use the web tools; the write scope below is unchanged.

| Value | Claude Code | Codex |
|---|---|---|
| unset | no web tools (as before) | nothing is passed: Codex keeps its own default |
| `none` | no web tools | `-c web_search="disabled"` |
| `search` | `WebSearch` | `-c web_search="cached"` |
| `fetch` | `WebSearch` and `WebFetch` | `-c web_search="live"` |

### `search` or `fetch`?

- **`search`**: the agent can run a search and gets a list of results (typically titles, links and short snippets). It cannot open a page, so it only knows what the results say. That is enough for "which Node versions are still supported?", "what is the latest release of this library?" or "is this API deprecated?".
- **`fetch`**: everything `search` does, plus reading the page behind a URL, so the page's text goes into the agent's context. You need it when the answer is inside a page: a specification, one section of an API reference, an issue thread, or a URL you put in the task.

The two are separate levels because the risk is different. Text read from a page can carry instructions written for the agent ("ignore your rules and ..."), known as prompt injection. With `fetch` that text arrives in full; with `search` only snippets do. The more an agent can do (edit your repository, run commands), the more this matters.

**Which agents to give it to.** Start with nothing. Give `search` to roles that look things up. Give `fetch` only to roles that really must read specific pages and do little editing, such as a requirements or research role like `pm`. Keep the members that edit your repo (for example `fe-member`, `qa-member`) off, and have the lead or the pm look things up and put the result in the task.

### Things to know

- **Unset is not `none`.** Unset leaves each runtime's own default alone: Claude Code has no web tools, but Codex may already have web search on. Set `none` to turn it off explicitly.
- **Codex has one `web_search` setting, not two tools**, so `search` and `fetch` map to `cached` and `live`. As Codex describes them, `cached` answers from an index instead of browsing, and `live` searches the web in real time; this is an approximation by risk. `codex exec` takes no `--search` flag, so agent-lyceum passes `-c web_search="..."`.
- **Not run end to end.** The Codex setting and its allowed values were checked against Codex 0.160.0, but the behaviour of `cached` / `live` and of Claude's two tools was not exercised against the real CLIs (that costs tokens). Try it once on the agent before relying on it.
- `call` reads the field from `team.yaml`, and `run --agent` keeps it.

```yaml
# team.yaml
agents:
  pm:
    runtime: claude-code
    allow_web: fetch        # may search and read pages; agents without the field have no web tools
```

## Write scope

Default rules (everything else in the repo is unrestricted):

| Target | Rule |
|---|---|
| own memory dirs, own `outbox/` | writable |
| any `AGENT.md`, `COMMON.md`, repo `CLAUDE.md`/`AGENTS.md` | read-only; the lead (`can_edit_agent_md`) may edit them |
| other agents' memory/inbox/outbox, `runs/`, config files | not writable |

Enforcement is layered because no single mechanism is complete:

- **Claude Code**: per-run `--settings` with `Edit(...)` rules **plus** the OS sandbox (`allowWrite`/`denyWrite`, `allowUnsandboxedCommands: false`). Without the sandbox, `python -c` and similar bypass Edit rules, so the sandbox is required for the `os` level.
- **Codex**: `-s workspace-write` with `-c sandbox_workspace_write.writable_roots=[...]` (OS-enforced). Codex cannot forbid a single file inside the repo, so repo `CLAUDE.md`/`AGENTS.md` are protected by **post-hoc detection** only.
- **All runtimes**: protected files are hashed before the run; after each wake-up unauthorized changes are reverted, logged, and reported to the lead; what was written is kept in `runs/<run-id>/violations/` first.

`doctor` and `run` print every agent's level per category (`os`, `tool-rules`, `post-hoc`, `prompt-only`) and the paths it can write outside the repo. With `dispatcher.strict: true`, a run is refused unless memory, `AGENT.md` and other agents' context are OS-enforced.

Git in agent worktrees: an agent can write its worktree's `.git` pointer file and its private git dir, which could make git read a config or hooks the agent planted. So every git call the dispatcher makes into an agent's worktree pins the git dir, common dir and work tree recorded when the worktree was made, turns off hooks, fsmonitor, external diff and textconv, and refuses a worktree whose git files were redirected or linked elsewhere, whose HEAD is not its own branch, or that contains a nested repository. Claude additionally may not write those pointer files (`denyWrite`); Codex cannot forbid single files and relies on the pinning alone. Residual risks are listed in [spec 15](docs/specs/15-worktree-git-isolation.md#156-殘留風險). This does not claim the dispatcher can never run code an agent planted. A repository using the `reftable` ref backend is refused in worktree modes.

Known gaps: Claude Code's built-in Edit/Write tools are not sandboxed (covered by the `Edit` rules); Codex MCP tools and hooks run outside its sandbox; `--dangerously-bypass-approvals-and-sandbox` / `danger-full-access` disable everything. With `can_edit_agent_md`, a Codex lead's writable roots widen to whole agent directories.

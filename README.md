# agent-lyceum

[![npm version](https://img.shields.io/npm/v/agent-lyceum)](https://www.npmjs.com/package/agent-lyceum)

**English** | [繁體中文](README.zh-TW.md)

Configure and run a **team of agents** (Claude Code and/or Codex) that talk to each other through file mailboxes, each with its own persona (`AGENT.md`) and long-term memory folder. Writes are scoped: an agent can only change its own memory and outbox, never other agents' context or its own persona.

The tool keeps **its own data out of your repo**: configuration, mailboxes, logs, task memory and agent worktrees all live in one visible folder, `~/agent-lyceum-config/` (override with `AGENT_LYCEUM_HOME` or `--home`). What agents *produce* is a different matter: they edit your repo (directly when they run one at a time, or in git worktrees whose changes are brought into your working tree when they run in parallel). The only things agent-lyceum itself adds inside your repository are git bookkeeping: while a parallel run exists, `refs/agent-lyceum/<run-id>/*` snapshot refs, `agent-lyceum/<run-id>/<agent>` branches and worktree registrations under `.git`; `agent-lyceum clear` removes them. See [docs/upgrading-run-v2.md](docs/upgrading-run-v2.md) if you are coming from an older version.

```bash
npx agent-lyceum init                     # create the home + global agent library
npx agent-lyceum project add web --dir ~/code/web-app
npx agent-lyceum validate --project web   # check config + show enforcement levels
npx agent-lyceum run --task-file spec.md  # inside the repo, the project is auto-detected
npx agent-lyceum status
```

The installed binary is `agent-lyceum`. To run the latest unreleased code straight from GitHub, use `npx github:gogogohuang/agent-lyceum <command>` instead.

Requires Node 20+, plus `claude` and/or `codex` on your `PATH` (already logged in). macOS and Linux (Linux needs `bwrap` for OS sandboxing); Windows only gets warnings.

## Commands

| Command | What it does |
|---|---|
| `init [-y]` | Create the home and the global agent library. [details](docs/commands.md#init) |
| `project add <name> --dir <repo>` | Register a project. [details](docs/commands.md#project-add) |
| `project list` / `project remove <name> [--purge]` | List or unregister projects. [details](docs/commands.md#project-list-and-remove) |
| `validate [-p name] [--task-file f]` | Validate the merged config and show each agent's enforcement level. [details](docs/commands.md#validate) |
| `run ["task"] [--task-file f] [--agent a] [-p name]` | Give the task to the lead and run until done; with `--agent`, to one member alone. [details](docs/commands.md#run) |
| `call <agent> ["task"] [--task-file f] [--dir d]` | Call one global agent on its own, outside any project; prints its answer. [details](docs/commands.md#call) |
| `resume [run-id] [-p name]` | Continue an interrupted or failed run. [details](docs/commands.md#resume) |
| `answer <run-id> [--no-edit] [-p name]` | Answer the questions a waiting run asked, then continue it. [details](docs/commands.md#answer) |
| `status [-p name] [--monitor]` | Show agents, mail, the current wake-up and past runs (`--json`, `--monitor`). [details](docs/commands.md#status) |
| `clear <run-id> [-p name] [--dry-run] [--keep-worktrees]` | Delete a run with its task memory and worktrees. [details](docs/commands.md#clear) |
| `config show --resolved [-p name] [--json]` | Print every effective setting and where it came from. [details](docs/commands.md#config-show) |
| `doctor [-p name] [--json]` | Check config, git, the lock and runtime CLIs without running agents. [details](docs/commands.md#doctor) |
| `memory tidy [-p name] [--agent a] [--layer project\|global] [--dry-run]` | Have agents tidy their own memory (manual only; archives, never deletes). [details](docs/commands.md#memory-tidy) |
| `memory restore <timestamp> -p name --agent a` | Undo a tidy: move its archived files back. [details](docs/commands.md#memory-restore) |
| `unlock [-p name] --force` | Remove the project lock a crashed run left behind. [details](docs/commands.md#unlock) |

Ctrl-C cancels a run cleanly and it can be continued with `resume` ([Stopping a run](docs/commands.md#stopping-a-run)). `run` and `resume` exit `0` only when the lead reported `completed`, `2` for partial or blocked, `1` for failed, `3` while waiting for your answers, `130` for cancelled ([Exit codes](docs/commands.md#exit-codes)). Without `-p`, the project is inferred from the current directory ([Choosing the project](docs/commands.md#choosing-the-project)).

## Monitor mod (Claude Code)

`plugins/status-monitor` is a Claude Code **mod**, not an ordinary plugin: it is written against Claude Code's mod hooks API (`import type { Register } from 'claude-code'`) and runs inside the Claude Code session, where it adds a status line entry, toasts and a `/status-monitor` pane that poll `agent-lyceum status --json`. It needs a Claude Code build that supports mods; it does not change how agent-lyceum itself runs. It shows live run status for one or several projects.

**Load it.** Build first (`npm run build`; the mod runs `dist/cli.js`), then start a session with:

```
claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor
```

`--plugin-dir` only applies when a session starts; an already-open session must be restarted (`claude --resume --plugin-dir ...` keeps the conversation). To load it every time, add `alias claude='claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor'` to your shell rc, or, for hosts where you cannot pass a flag (desktop app, SDK), set `CLAUDE_CODE_PLUGIN_DIRS` to the mod folder. While a session is running, saving a file in the mod folder hot-reloads it.

**Use it.**
- **Status line:** always on once loaded (`team 讀取中…` until the first poll, `team 無法取得狀態：…` when the CLI cannot run); shows the run state, round `n/max`, output tokens, the current step and unread mail. With several projects it shows one overview line (`team 1/3 running · a ... | b ...`).
- **Toasts:** a message pops up when a run finishes, is interrupted, or an agent's wake fails (prefixed `[project]` when several are watched). Nothing to do.
- **`/status-monitor`:** type it to open (or, if already open, close) the pane. It is off at session start unless `autoOpen` is set. In the **fullscreen layout** (`"tui": "fullscreen"` in `~/.claude/settings.json`, restart the session to apply; `/tui fullscreen` does the same) from 110 terminal columns it docks on the right at half the terminal width, and tabs and **關閉** (Close) can be clicked. Otherwise it shows above the prompt; the layout is fixed when the session starts, so a session started on the main screen stays that way. Keyboard (works in both): `x` closes, `1`-`9` or Tab/Enter switch task, Esc returns to the prompt, running the command again also closes. It shows, per project: the run id and state, task, progress and checklist, the agents working now and the queued mail, blocked integrations, notes and result summary, output tokens per runtime, per-agent wake statistics, the last 8 wakes. Each running task is a tab, newest first; finished and interrupted runs are not listed. It refreshes with the polling interval while open.

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
└── projects/<project>/
    ├── project.yaml                  # team, repo dir, overrides
    ├── agents/<agent>/{AGENT.md?, memory/}   # project-level persona (optional) + project memory
    ├── shared/common/COMMON.md
    ├── lock.json                     # held while a run is active: one run per project
    └── runs/<run-id>/{task.md, log.jsonl, state.json, snapshots/, agents/, mail/{inbox,outbox}/<agent>/}
```

`team.yaml` defines reusable agents; `project.yaml` picks the team and overrides fields. Objects merge field by field, arrays (`can_message`, `owns`) are replaced. Relative paths resolve against the folder of the file they are written in; `~` is allowed.

```yaml
# project.yaml
dir: ~/code/web-app
team: { lead: lead }
dispatcher: { max_rounds: 30, max_parallel: 1, wake_timeout_sec: 600, retry: 1, strict: false, workspace_mode: auto, log_max_bytes: 8388608 }
agents:
  lead:      { resume: true, can_message: all, can_edit_agent_md: true }
  fe-member: { runtime: codex, can_message: [lead], owns: ["src/web/**"] }
  qa-member: { can_message: [lead], owns: ["tests/**"] }
```

Agent fields: `runtime` (`claude-code`|`codex`; optional when `model` is recognizable: `opus`/`sonnet`/`haiku`/`claude-*` → Claude Code, `gpt-*`/`o3`/`*codex*` → Codex; precedence: project runtime > project model > global runtime > global model), `model`, `effort` (Claude Code: `low`|`medium`|`high`|`xhigh`|`max` via `--effort`; Codex: `minimal`|`low`|`medium`|`high`|`xhigh` via `model_reasoning_effort`; unset = CLI default), `agent_md`, `memory.global` / `memory.project`, `resume`, `can_message` (`all` or list; default `[lead]`, lead default `all`), `can_edit_agent_md` (default only the lead), `can_ask_user` (may send `type: ask` mail to you and pause the run for an answer; default only the lead), `owns` (repo globs).

Rules checked by `validate`: ≥ 2 agents (the lead and one member; the template has three), the lead is a listed agent, every agent has a runtime (explicit or inferred from `model`) and an existing `AGENT.md`, `effort` is valid for the agent's runtime (warning if `runtime` contradicts a recognizable `model`), `can_message` targets exist, memory dirs don't overlap, and with `max_parallel > 1` every non-lead agent needs non-overlapping `owns` and the repo must be a git repository.

## How a run works

1. The task (text, or a copy of `--task-file` kept read-only as `runs/<id>/task.md`) becomes the first mail to the lead. Tasks ≤ 16 KB are inlined; larger ones are passed by reference. Files over 1 MB are rejected.
2. The dispatcher wakes whichever agent has unread mail with `claude -p` or `codex exec` (headless). Each wake-up is a fresh session unless `resume: true`.
3. Every wake-up prompt contains the agent's `AGENT.md`, the team protocol, `COMMON.md` (read-only, ≤ 8 KB), the `MEMORY.md` index of each memory dir, the **oldest** unread message in full (one message per wake-up; the lead instead takes a run of up to 5 `reply`/`failure` messages at once and decides on them together), and titles of the queued ones, which stay unread until their own wake-up.
4. Agents send mail by writing a Markdown file with frontmatter (`to`, `type`, `subject`) into **their own** `outbox/`. The dispatcher checks `can_message`, stamps the real sender, and moves it to the recipient's `inbox/`. Handled mail goes to `inbox/<agent>/read/`. Mailboxes belong to one run (`runs/<run-id>/mail/`), so mail never crosses runs. Runs started by older versions keep using the shared `shared/{inbox,outbox}/` mailboxes (their mail is never moved); resuming such a run shows that legacy layout.
   The body of every `task` and `reply` should carry fixed `##` headings (injected into each agent's prompt): `task` → `Goal`, `Acceptance criteria`, `Scope`, `Upstream`; `reply` → `Changes`, `Verification`, `Open items`, `Risks` (write `None` when empty; `done` is exempt). Mail missing a heading is still delivered, with a warning note prepended and a `format-warning` entry in the run log.
5. The run ends when the lead sends `type: done`, when all mailboxes are empty, or after `max_rounds` wake-ups. A `done` must declare `outcome: completed|partial|blocked|failed` in its frontmatter and carry `## Result`, `## Files`, `## Verification`, `## Not done`; `completed` also needs every `## Steps` item ticked. A `done` that breaks this is sent back to the lead (twice at most, then it is kept as `partial`). Agent-lyceum does not verify what the lead reports. A failed wake-up is retried once, then reported to the lead as a failure message (if the lead itself fails, the run aborts).

Parallelism (`max_parallel > 1`) only runs agents with disjoint `owns`, and never alongside the lead. Each non-lead agent then works in its **own git worktree** (`projects/<name>/worktrees/<run-id>/<agent>`, branch `agent-lyceum/<run-id>/<agent>`) cut from a snapshot of the repo as it is when the agent is woken (`refs/agent-lyceum/<run-id>/base-<n>`; it includes the lead's uncommitted and new, non-ignored files; your HEAD, branches and working tree are not touched). `dispatcher.workspace_mode` is `auto` (worktrees when `max_parallel > 1`), `worktree` or `shared`; `shared` cannot be combined with parallel agents. A parallel run refuses to start while the repo has uncommitted changes of yours, and when the repo is not a git repository (run sequentially instead). When a member finishes, the dispatcher commits its worktree and brings the changes into your working tree (not your index or HEAD) before the lead reads the member's mail. Every changed path is checked first: it must be inside the member's `owns` (renames and deletions included), must not be `CLAUDE.md`/`AGENTS.md`, and symlinks may not point out of the project or the member's `owns`. If a file also changed in your repo since the member's snapshot, if a check fails, or if `git apply` fails, nothing is applied: the work stays on its branch and worktree, a report and patch are written to `runs/<run-id>/integration/`, the lead is told, and the run cannot end as `completed` (it ends `blocked`). A worktree isolates files only: it cannot isolate side effects on external services, databases or the network.

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

`validate` and `run` print every agent's level per category (`os`, `tool-rules`, `post-hoc`, `prompt-only`) and the paths it can write outside the repo. With `dispatcher.strict: true`, a run is refused unless memory, `AGENT.md` and other agents' context are OS-enforced.

Known gaps: Claude Code's built-in Edit/Write tools are not sandboxed (covered by the `Edit` rules); Codex MCP tools and hooks run outside its sandbox; `--dangerously-bypass-approvals-and-sandbox` / `danger-full-access` disable everything. With `can_edit_agent_md`, a Codex lead's writable roots widen to whole agent directories.

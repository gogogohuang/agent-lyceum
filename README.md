# agent-team

[![npm version](https://img.shields.io/npm/v/@gogogohuang/agent-team)](https://www.npmjs.com/package/@gogogohuang/agent-team)

**English** | [繁體中文](README.zh-TW.md)

Configure and run a **team of agents** (Claude Code and/or Codex) that talk to each other through file mailboxes, each with its own persona (`AGENT.md`) and long-term memory folder. Writes are scoped: an agent can only change its own memory and outbox, never other agents' context or its own persona.

The tool **never writes into your repo**. Everything lives in one visible folder, `~/agent-team-config/` (override with `AGENT_TEAM_HOME` or `--home`).

```bash
npx @gogogohuang/agent-team init                     # create the home + global agent library
npx @gogogohuang/agent-team project add web --dir ~/code/web-app
npx @gogogohuang/agent-team validate --project web   # check config + show enforcement levels
npx @gogogohuang/agent-team run --task-file spec.md  # inside the repo, the project is auto-detected
npx @gogogohuang/agent-team status
```

The installed binary is `agent-team`. To run the latest unreleased code straight from GitHub, use `npx github:gogogohuang/agent-team <command>` instead.

Requires Node 20+, plus `claude` and/or `codex` on your `PATH` (already logged in). macOS and Linux (Linux needs `bwrap` for OS sandboxing); Windows only gets warnings.

## Commands

| Command | What it does |
|---|---|
| `init [-y]` | Create the home and a global agent library (`lead`, `fe-member`, `qa-member`). Asks before creating the default path. |
| `project add <name> --dir <repo>` | Register a project: creates `projects/<name>/project.yaml`, shared folders and `COMMON.md`. |
| `project list` / `project remove <name> [--purge]` | List projects / unregister (keeps context unless `--purge`). |
| `validate [-p name] [--task-file f]` | Validate the merged config and print each agent's enforcement level. Exit 1 on errors. |
| `run ["task"] [--task-file f] [-p name]` | Give the task to the lead and run the dispatcher until done. Give *either* text or `--task-file`. |
| `resume [run-id] [-p name]` | Continue an interrupted or failed run (each `run` is its own task; without an id, the newest run that is neither done nor running): same run dir, sessions and round count; the task is not re-sent and unread mail is picked up again. Refuses if the run is still alive or already done. |
| `status [-p name] [--monitor]` | Agents, unread mail, what is running right now (agent, elapsed time, message being handled), last run (task source, rounds, end reason, output tokens). Without `--monitor` it also prints the full wake-by-wake record of the latest run; `--monitor` keeps a live page open showing only the latest three wakes of each run. `--task-id <id>` prints everything about one task (every wake, its result, log directory). `--task-list [project]` lists every run of the project with its id, state, rounds and task (feed the id to `resume`). |
| `clear <run-id> [-p name]` | Delete a task (run) by id; refuses if it is still running. List ids with `status --task-list`. |
| `unlock [-p name] --force` | Remove the project's run lock left behind by a crashed run (only one run per project at a time). Without `--force` it only shows who holds the lock. |

**Exit codes of `run` / `resume`:** `0` only when the lead reported `outcome: completed`; `2` for `partial` or `blocked` (also when the run went idle or hit `max_rounds` without a done); `1` for `failed` (also when the lead itself failed); `130` for `cancelled`. *Upgrading:* before this version an `idle` run exited `0` and a failed lead exited `2`; scripts that treated `0` as "the run ended" must now check for `0` as "the work was completed". Runs that ended before outcomes were recorded show as unverified (`partial`) and are not reported as a success.

Without `--project`, the project is the registered one whose `dir` is the longest prefix of the current directory; if none matches the command lists the registered projects and stops.

## Layout

```
~/agent-team-config/
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
dispatcher: { max_rounds: 30, max_parallel: 1, wake_timeout_sec: 600, retry: 1, strict: false }
agents:
  lead:      { resume: true, can_message: all, can_edit_agent_md: true }
  fe-member: { runtime: codex, can_message: [lead], owns: ["src/web/**"] }
  qa-member: { can_message: [lead], owns: ["tests/**"] }
```

Agent fields: `runtime` (`claude-code`|`codex`; optional when `model` is recognizable: `opus`/`sonnet`/`haiku`/`claude-*` → Claude Code, `gpt-*`/`o3`/`*codex*` → Codex; precedence: project runtime > project model > global runtime > global model), `model`, `effort` (Claude Code: `low`|`medium`|`high`|`xhigh`|`max` via `--effort`; Codex: `minimal`|`low`|`medium`|`high`|`xhigh` via `model_reasoning_effort`; unset = CLI default), `agent_md`, `memory.global` / `memory.project`, `resume`, `can_message` (`all` or list; default `[lead]`, lead default `all`), `can_edit_agent_md` (default only the lead), `owns` (repo globs).

Rules checked by `validate`: ≥ 3 agents, the lead is a listed agent, every agent has a runtime (explicit or inferred from `model`) and an existing `AGENT.md`, `effort` is valid for the agent's runtime (warning if `runtime` contradicts a recognizable `model`), `can_message` targets exist, memory dirs don't overlap, and with `max_parallel > 1` every non-lead agent needs non-overlapping `owns`.

## How a run works

1. The task (text, or a copy of `--task-file` kept read-only as `runs/<id>/task.md`) becomes the first mail to the lead. Tasks ≤ 16 KB are inlined; larger ones are passed by reference. Files over 1 MB are rejected.
2. The dispatcher wakes whichever agent has unread mail with `claude -p` or `codex exec` (headless). Each wake-up is a fresh session unless `resume: true`.
3. Every wake-up prompt contains the agent's `AGENT.md`, the team protocol, `COMMON.md` (read-only, ≤ 8 KB), the `MEMORY.md` index of each memory dir, the **oldest** unread message in full (one message per wake-up; the lead instead takes a run of up to 5 `reply`/`failure` messages at once and decides on them together), and titles of the queued ones, which stay unread until their own wake-up.
4. Agents send mail by writing a Markdown file with frontmatter (`to`, `type`, `subject`) into **their own** `outbox/`. The dispatcher checks `can_message`, stamps the real sender, and moves it to the recipient's `inbox/`. Handled mail goes to `inbox/<agent>/read/`. Mailboxes belong to one run (`runs/<run-id>/mail/`), so mail never crosses runs. Runs started by older versions keep using the shared `shared/{inbox,outbox}/` mailboxes (their mail is never moved); resuming such a run shows that legacy layout.
   The body of every `task` and `reply` should carry fixed `##` headings (injected into each agent's prompt): `task` → `Goal`, `Acceptance criteria`, `Scope`, `Upstream`; `reply` → `Changes`, `Verification`, `Open items`, `Risks` (write `None` when empty; `done` is exempt). Mail missing a heading is still delivered, with a warning note prepended and a `format-warning` entry in the run log.
5. The run ends when the lead sends `type: done`, when all mailboxes are empty, or after `max_rounds` wake-ups. A `done` must declare `outcome: completed|partial|blocked|failed` in its frontmatter and carry `## Result`, `## Files`, `## Verification`, `## Not done`; `completed` also needs every `## Steps` item ticked. A `done` that breaks this is sent back to the lead (twice at most, then it is kept as `partial`). Agent-team does not verify what the lead reports. A failed wake-up is retried once, then reported to the lead as a failure message (if the lead itself fails, the run aborts).

Parallelism (`max_parallel > 1`) only runs agents with disjoint `owns`, and never alongside the lead.

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
- **All runtimes**: protected files are hashed before the run; after each wake-up unauthorized changes are reverted, logged, and reported to the lead.

`validate` and `run` print every agent's level per category (`os`, `tool-rules`, `post-hoc`, `prompt-only`) and the paths it can write outside the repo. With `dispatcher.strict: true`, a run is refused unless memory, `AGENT.md` and other agents' context are OS-enforced.

Known gaps: Claude Code's built-in Edit/Write tools are not sandboxed (covered by the `Edit` rules); Codex MCP tools and hooks run outside its sandbox; `--dangerously-bypass-approvals-and-sandbox` / `danger-full-access` disable everything. With `can_edit_agent_md`, a Codex lead's writable roots widen to whole agent directories.

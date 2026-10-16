# agent-lyceum

[![npm version](https://img.shields.io/npm/v/agent-lyceum)](https://www.npmjs.com/package/agent-lyceum)

**English** | [繁體中文](README.zh-TW.md)

Give a task to a **team of agents** (Claude Code and/or Codex) instead of one overloaded session. A lead splits the work, specialists such as a frontend dev, a reviewer or a PM do their part in your repo, and the run ends when the lead says it is done.

## Why

- **Roles that stay in role.** Each agent has its own persona (`AGENT.md`) and long-term memory, so a reviewer keeps reviewing instead of drifting into writing code.
- **Agents can't rewrite the rules.** An agent can only write its own memory and outbox. It can't touch other agents' context or its own persona, and this is enforced by the OS sandbox where possible, not just by a prompt. See [Write scope](docs/write-scope.md).
- **Mix runtimes.** Claude Code and Codex agents work in the same team.
- **Backup models.** If a model is rate-limited, out of quota or unreachable, a run can switch to a backup model or runtime instead of stopping. See [Configuration](docs/configuration.md#fallback-models).
- **Nothing hidden.** Agents talk through plain-file mailboxes, so every message, decision and memory is a file you can read, grep and diff. The dispatcher never merges for you.

**Not a fit** for small, one-shot edits: a single Claude Code or Codex session is faster and cheaper. Use a team when the task is big enough to split, review or run in parallel.

## Quick start

Requires Node 20+, plus `claude` and/or `codex` on your `PATH` (logged in). macOS and Linux (Linux needs `bwrap` for OS sandboxing); Windows only gets warnings.

```bash
npx agent-lyceum demo                       # 3 agents fix a failing test in a throwaway sandbox (real calls)

# on your own repo:
npx agent-lyceum init                       # create the home + global agent library
npx agent-lyceum project add web --dir ~/code/web-app
npx agent-lyceum doctor --project web       # check config, show enforcement levels
npx agent-lyceum run --task-file spec.md    # inside the repo the project is auto-detected
npx agent-lyceum status
```

Latest unreleased code: `npx github:gogogohuang/agent-lyceum <command>`.

## How it works

1. Your task becomes the first mail to the **lead**.
2. The dispatcher wakes whichever agent has unread mail (`claude -p` / `codex exec`, headless).
3. Agents reply by writing mail to their own `outbox/`; the dispatcher checks `can_message` and delivers it.
4. The run ends when the lead sends `done`.

Its own data (config, mailboxes, logs, memory, worktrees) lives in `~/agent-lyceum-config/`, not in your repo. Concurrency needs no configuration. In a git repo with a commit, every run works in its own git worktree and ends on its own branch (`agent-lyceum/<run>/…`), members with pending mail wake in parallel, and any number of runs can be active at once; the result is not written into your working tree, so use `git merge <branch>` or `open_pr`, and note that a run starts from `HEAD` and does not see your uncommitted edits. In a non-git folder, a repo with no commit, or a repo using reftable, the run works directly in the folder, one agent at a time (an info line says why), and only one such run can be active. agent-lyceum never merges. Upgrading from a version with `owns`, `max_parallel`, `max_concurrent_runs` or `workspace_mode`: see [Upgrading](docs/upgrading-run-v2.md). More: [How a run works](docs/how-it-works.md), [Configuration](docs/configuration.md).

## Commands

| Command | What it does |
|---|---|
| `init` | Create the home and the global agent library. [details](docs/commands.md#init) |
| `project add` / `project` / `project remove` | Register, list or remove projects. [details](docs/commands.md#project-add) |
| `doctor` | Check config, git, lock and runtime CLIs without running agents. [details](docs/commands.md#doctor) |
| `status` | Show agents, mail, the current wake-up and past runs. [details](docs/commands.md#status) |
| `run` | Give the task to the lead and run until done. [details](docs/commands.md#run) |
| `resume` | Continue an interrupted run, or reopen a finished one with a follow-up. [details](docs/commands.md#resume) |
| `clear` | Delete a run, or remove a stale lock. [details](docs/commands.md#clear) |
| `call <agent>` | Ask one global agent on its own, outside any project. [details](docs/commands.md#call) |
| `demo` | Try a 3-agent team on a throwaway sample repo. [details](docs/commands.md#demo) |
| `tidy` | Have agents tidy their own memory (archives, never deletes). [details](docs/commands.md#tidy) |

`agent-lyceum <command> --help` prints the full options. Ctrl-C cancels cleanly; [exit codes](docs/commands.md#exit-codes) tell scripts how a run ended.

## Configuration

`team.yaml` defines reusable agents; `project.yaml` picks the team and overrides fields:

```yaml
# project.yaml
dir: ~/code/web-app
team: { lead: lead }
agents:
  lead:      { can_message: all, can_edit_agent_md: true }
  fe-member: { runtime: codex, can_message: [lead] }
  pm:        { can_message: [lead], allow_web: fetch }
```

Folder layout, every agent field and the rules `doctor` checks: [Configuration](docs/configuration.md).

## Topics

| Topic | Read |
|---|---|
| Run lifecycle, parallel agents, several runs at once, follow-ups, opening a PR | [How a run works](docs/how-it-works.md) |
| What agents may write, sandbox levels, known gaps | [Write scope](docs/write-scope.md) |
| Letting an agent search or fetch the web | [Web access](docs/web-access.md) |
| Live run status inside Claude Code | [Monitor mod](docs/monitor.md) |
| All commands in full | [Commands](docs/commands.md) |
| Coming from an older version | [Upgrading to run v2](docs/upgrading-run-v2.md) |

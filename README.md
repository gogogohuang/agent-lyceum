# agent-lyceum

[![npm version](https://img.shields.io/npm/v/agent-lyceum)](https://www.npmjs.com/package/agent-lyceum)

**English** | [繁體中文](README.zh-TW.md)

Run a **team of agents** (Claude Code and/or Codex) on your repo. They talk through file mailboxes, and each has its own persona (`AGENT.md`) and long-term memory. An agent can only write its own memory and outbox, never other agents' context or its own persona.

## Quick start

Requires Node 20+, plus `claude` and/or `codex` on your `PATH` (logged in). macOS and Linux (Linux needs `bwrap` for OS sandboxing); Windows only gets warnings.

```bash
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

Its own data (config, mailboxes, logs, memory, worktrees) lives in `~/agent-lyceum-config/`, not in your repo. Agents edit your repo directly, or in git worktrees when running in parallel. agent-lyceum never merges. More: [How a run works](docs/how-it-works.md), [Configuration](docs/configuration.md).

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
  fe-member: { runtime: codex, can_message: [lead], owns: ["src/web/**"] }
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

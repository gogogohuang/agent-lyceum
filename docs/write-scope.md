# Write scope

Default rules (everything else in the repo is unrestricted):

| Target | Rule |
|---|---|
| own memory dirs, own `outbox/` | writable |
| own `agents/<self>/`, including a project `AGENT.md` created there | writable by that member. The file replaces the global persona for this project on the next run. The global file stays read-only |
| `shared/common/` (`COMMON.md`, `records/`) | the lead writes; every other agent is read-only |
| another agent's `AGENT.md`, a global `AGENT.md`, repo `CLAUDE.md`/`AGENTS.md` | read-only; the lead (`can_edit_agent_md`) may edit them |
| the run's handoff notes `task-memory/<run-id>/_shared/` | the lead writes; every other agent is read-only |
| other agents' memory/inbox/outbox, `runs/`, config files | not writable |

Enforcement is layered because no single mechanism is complete:

- **Claude Code**: per-run `--settings` with `Edit(...)` rules **plus** the OS sandbox (`allowWrite`/`denyWrite`, `allowUnsandboxedCommands: false`). Without the sandbox, `python -c` and similar bypass Edit rules, so the sandbox is required for the `os` level.
- **Codex**: `-s workspace-write` with `-c sandbox_workspace_write.writable_roots=[...]` (OS-enforced). Codex cannot forbid a single file inside the repo, so repo `CLAUDE.md`/`AGENTS.md` are protected by **post-hoc detection** only.
- **Cursor**: `agent` with `--sandbox enabled` and a per-wake `cli-config.json` in `workDir`, read via `CURSOR_CONFIG_DIR` (`permissions.allow`/`deny` from write policy only — the user's own `permissions.allow` is **not** merged, so a home `Shell(*)` cannot widen the agent). This is **tool-rules** enforcement, not Claude/Codex OS per-path `denyWrite`; repo `CLAUDE.md`/`AGENTS.md` rely on **post-hoc detection** like Codex. `auth.json` is linked (symlink, copy as fallback) from your Cursor config dir into the run-scoped `workDir` so login can survive `CURSOR_CONFIG_DIR`; nothing needs it to stay there after the wake. Writable paths outside `--workspace` (memory, outbox) are also passed as `--add-dir`. `resume` passes the stored `session_id`; Cursor sessions may be scoped to the config dir (`CURSOR_CONFIG_DIR` is the per-run `workDir`), so resuming across runs is **unverified**.
- **All runtimes**: protected files are hashed before the run; after each wake-up unauthorized changes are reverted, logged, and reported to the lead; what was written is kept in `runs/<run-id>/violations/` first.

**Changes the guard cannot attribute.** `COMMON.md`, the records tree `shared/common/records/` and the team's `AGENT.md` files are shared by all runs of a project. If no agent in a batch of wake-ups may edit such a file, and another run of the same project is live (its run lock is held by a living process) at the start or end of that batch, a change to the file cannot be attributed to this run. The guard then does not revert it, keeps no copy in `violations/`, and sends the lead no mail; the change becomes the new baseline, and the run log records a `protected-change-unattributed` event (plus one console line). Why: another run's lead legitimately edits these files, and reverting that woke this run's lead for nothing. This skips only what the guard cannot attribute: a violation by this run's own agent inside that window is also not reverted, and then only the runtime/OS sandbox above stops it. Per-run files (the run's handoff notes, repo `CLAUDE.md`/`AGENTS.md`) and any change while no other run is live are reverted and reported as before. See [Several runs at once](how-it-works.md#several-runs-at-once).

`doctor` and `run` print every agent's level per category (`os`, `tool-rules`, `post-hoc`, `prompt-only`) and the paths it can write outside the repo. With `dispatcher.strict: true`, a run is refused unless memory, `AGENT.md`, other agents' context and (for non-lead agents) the handoff notes are OS-enforced.

Git in agent worktrees: an agent can write its worktree's `.git` pointer file and its private git dir, which could make git read a config or hooks the agent planted. So every git call the dispatcher makes into an agent's worktree pins the git dir, common dir and work tree recorded when the worktree was made, turns off hooks, fsmonitor, external diff and textconv, and refuses a worktree whose git files were redirected or linked elsewhere, whose HEAD is not its own branch, or that contains a nested repository. Claude additionally may not write those pointer files (`denyWrite`); Codex cannot forbid single files and relies on the pinning alone. Residual risks are listed in [spec 15](specs/15-worktree-git-isolation.md#156-殘留風險). This does not claim the dispatcher can never run code an agent planted. A repository using the `reftable` ref backend is refused in worktree modes.

Known gaps: Claude Code's built-in Edit/Write tools are not sandboxed (covered by the `Edit` rules); Codex MCP tools and hooks run outside its sandbox; `--dangerously-bypass-approvals-and-sandbox` / `danger-full-access` disable everything. With `can_edit_agent_md`, a Codex lead's writable roots widen to whole agent directories.

## Sandbox allowances

`sandbox` on an agent (`write`, `network`, `local_binding`, `unix_sockets`; field reference in [Configuration](configuration.md#sandbox-allowances), design in [spec 25](specs/25-sandbox-allowances.md)) widens the OS sandbox for that agent only, and only when set. It is implemented in 0.28.0; the end-to-end effect of each key in a real wake-up is **unverified**.

- **`write`** adds directories to the agent's write scope, the same list that gives Claude its `Edit` rules, `allowWrite` and `--add-dir`, Codex its `writable_roots`, and Cursor its `Write(...)` rules in `cli-config.json` plus `--add-dir` for paths outside `--workspace`. Protected paths can never be added, for example: anything inside the config home or the repo, every `AGENT.md`, memory folder, inbox and outbox, `COMMON.md`, the records folder, the run's data, other agents' worktrees and git dirs, the git common dir, the worktrees root, the repo's `CLAUDE.md`/`AGENTS.md`, `~/.claude`, `~/.codex`, and their ancestors. The complete list is in [Configuration](configuration.md#sandbox-allowances); a refused invocation is logged as `sandbox-refused` and is not retried.
- **`unix_sockets`** adds Unix sockets under each listed path, to **bind and to connect**, not only to listen in a test. Anything in that folder is reachable, so keep sockets such as Docker's or ssh-agent's out of it. Claude Code only; Codex and Cursor get nothing and `doctor` warns.
- **`local_binding`** (Claude Code only) allows bind and inbound connections on **any local IP**, not only loopback, plus outbound connections to services on localhost. It is not "serve on localhost only". Per the Claude Code docs it has no effect on Linux ([sandboxing](https://code.claude.com/docs/en/sandboxing)). It does not cover Unix sockets.
- **`network`**: per domain on Claude Code; all-or-nothing on Codex (any listed domain opens all hosts); **not applied** on Cursor (no network setting is emitted yet, so nothing is opened; `doctor` says "not applied by cursor").
- **`allow_web` on Cursor**: `allow_web: fetch` adds a `WebFetch(*)` allow rule; `none` or unset denies it. `allow_web: search` has no Cursor permission token yet, so web fetch stays denied unless you set `fetch` (see [Web access](web-access.md)).
- **Unchanged:** `allowUnsandboxedCommands` stays `false`, Codex stays in `workspace-write`, and no key gives any agent, the lead included, a way to run outside the sandbox. Non-lead agents never run outside it. (The dispatcher, not an agent, pushes the branch and opens the PR when the lead's accepted `done` asks for it.)
- **Write scope, not read isolation:** these keys widen what an agent may write or connect to. They do not restrict reads, and nothing here keeps an agent from reading another agent's memory.
- **No OS sandbox:** Claude's `write` then widens only the `Edit` tool rules (Bash can bypass them) and the other keys do nothing; on Codex it is prompt-only. A path is checked before each invocation, but a path swapped between the check and the spawn is not defended against; the OS sandbox is the boundary.

**Tests that start child processes.** Under Claude's sandbox, `npm test` fails when `tsx` children cannot open their IPC socket (`listen EPERM .../tsx-<uid>/*.pipe`); the diagnosis is in [Sandbox blocks](sandbox-blocks.md). `unix_sockets: [<your $TMPDIR>/tsx-<uid>]` (resolve `$TMPDIR` yourself; it is not expanded) is the intended fix, but it is **unverified** end to end, and a Claude Code 2.1.89 report says scoped Unix allowances covered connect only ([claude-code#41817](https://github.com/anthropics/claude-code/issues/41817)). The known workaround remains a `NODE_OPTIONS="--import stub.mjs"` stub that turns `net.Server.listen` on `*.pipe` paths into a no-op.

## Approval-enrolled agents (stage 2b-1, not a working approval gate)

This is the first part of the approval gate ([store API](approval-store-api.md), [design](superpowers/specs/2026-11-13-approval-gate-design.md)). It only hardens how an *enrolled* agent is started. Nothing yet lets an agent ask for, or anyone grant, an approval.

- **Default off.** With no `<home>/executors.yaml`, or one whose `allow` lists are all empty, no agent is enrolled and arguments, `--settings`, environment and write scope are unchanged (`src/approval-runtime.ts:21`; `src/adapters/env.ts:11`).
- **Who is enrolled.** An agent whose role is in an executor's `allow` for that project, or for `call` (`src/approval-enrollment.ts:12-14`). `run`, `resume`, `run --agent` and `call` load the file when it exists (`src/config.ts:166`, `src/call.ts:56`). Fallback and tier candidates keep the agent's enrollment (`src/fallback.ts:53-55` copy the agent with `...agent`).
- **Unreadable `executors.yaml`.** If the file exists but cannot be read or parsed, `run`, `resume`, `run --agent`, `call` and `tidy` (not `tidy --dry-run` or `--undo`) stop before any agent starts, with an error naming the file and a fixed reason (`src/approval-runtime.ts:56-63`; `src/cli.ts:272,349,652`; `src/call.ts:57`). The reason never quotes file content. `status`, `doctor`, `clear` and `project` do not refuse to start; `doctor` loads the file and reports the error (`src/doctor-approval.ts:33-41`).
- **Claude, enrolled only** (`src/adapters/claude.ts`):
  - `--strict-mcp-config` with an empty MCP config, so neither user MCP servers nor a repo `.mcp.json` load (`:14,100`).
  - `--setting-sources user`, so a repo's `.claude/settings*.json` does not load (`:12,100`).
  - `sandbox.failIfUnavailable: true` in `--settings`, next to `enabled` and `allowUnsandboxedCommands: false` (`:63`). Hooks stay disabled (`disableAllHooks`).
  - The same applies to wakes with their own write policy (tidy) and to solo/`call` wakes, because it is built into the invocation, not into `invokeWithSandboxChecks` (`:35-37,76-77`).
- **Environment, enrolled only, both runtimes:** only `PATH`, `HOME`, `LANG`, `TERM`, `TMPDIR` and `USER`, and only those that are set. `AGENT_LYCEUM_AGENT` is therefore absent (`src/adapters/env.ts:4,10-14`). `USER` is needed to log in on macOS (spec section 8). Other agents keep the full environment.
- **Write denies, enrolled only** (`src/approval-policy.ts:21-30`, `src/policy.ts:229-230`): `approvals/`, `executors.yaml`, each executor's `command[0]`, `.claude/settings.json` and `.claude/settings.local.json` of the repo and of the agent's worktree, and the request directory of every *other* slot, listed one by one (never `requests/` as a whole, and not the agent's own slot). Every entry is emitted as written and, when different, in canonical form, so a symlinked executor command is also denied by its real target (`src/approval-policy.ts:22-34`).
- **Unsafe request directories fail the wake.** If listing the request directories hits a symlink, an unexpected entry, or more entries than the scan limit, the enrolled wake fails instead of running with a partial list (`src/approval-policy.ts:48-98,129-133`; `src/adapters/claude.ts:76-77`).
- **Codex is refused** for an enrolled agent, also as a fallback runtime, before the Codex invocation writes any file or starts Codex (`src/adapters/codex.ts:63-66`); for `call`, the call's log, `task.md` and memory folders already exist and a failed `result.md` is still written (`src/call.ts:165-167,216`). `doctor` already reports it as an error.

**Known limitations.** With `--setting-sources user`, the user-level `~/.claude/settings.json` still applies to enrolled agents; the check for that (spec section 3, premise 4 (ii)) is not built yet. `doctor` may print key names from an invalid `executors.yaml` (`src/approval-executors.ts:60`, `src/doctor-approval.ts:40`).

**Not built yet:** re-checking enrollment at each wake and refusing to wake a slot, `status` reasons, write access to `proposals/`, collecting requests, an approvals CLI, an executor runner. The real Claude CLI's acceptance of the new flags, the real sandbox's effect, and Linux are **unverified**; the macOS step-0 measurements are in spec section 8.

## Shared memory of parallel instances

When a member runs as several instances (see [Parallel instances of one member](how-it-works.md#parallel-instances-of-one-member)), only instance 1 (the member's own name) writes the member's shared memory (`memory.global`, `memory.project`). Instances 2 and up get that memory as read-only context and write only their own task memory (`task-memory/<run-id>/<member>--2`) and outbox; they are told to put lessons worth keeping in their reply to the lead. `can_edit_agent_md` is always `false` for instances 2 and up. (Spec 23.11, 23.12)

This is write scope, not read isolation: other instances can still read the shared memory, and nothing here keeps any agent from reading another agent's memory.

**Containment check.** The rule above only holds if no folder an extra instance may write (its task memory, outbox, worktree and git dir) is inside the member's shared memory, or contains it. agent-lyceum checks this on real paths (symlinks resolved; compared case-insensitively on macOS): before the first parallel task for a member, after an instance's folders are created, before an instance is woken, and on `resume`. If the check fails, the extra instance is not opened or woken, or `resume` is refused, and the message names both paths; the check fails closed. `doctor` warns early for memory paths that contain, or sit inside, the run data folders. A symlink inside a worktree that points at the shared memory is not seen by this check. (23.11)

**How strongly instances 2 and up are kept out of shared memory** (valid only when the containment check passes):

| Runtime / platform | Instance 2+ writing shared memory |
|---|---|
| Claude Code with the OS sandbox (macOS; Linux with `bwrap`) | refused by the OS (`denyWrite`) |
| Claude Code without the OS sandbox | `Edit` tool rules only; Bash can bypass them |
| Codex with the OS sandbox | the shared memory is not among the writable roots |
| Codex without the OS sandbox (Linux without `bwrap`) | **prompt only**: the instance is only told not to |

These are the paths the policy hands to each runtime; that the real CLI and sandbox honour them is unverified. The guard does not protect memory, so a write that gets through is not reverted: the last writer wins. Single-writer holds within one run only: `memory.project` is shared across runs, so the instances 1 of two simultaneous runs can still write it at the same time, as concurrent runs already could. (23.11)

**Proposals (spec 30).** An agent that runs alone (`run --agent`, `call -p`) may write proposals under `proposals/` in the project folder, which is not under the records, so the records' deny does not cover it. The guard now treats that agent as what it is: a write to the records is **reverted** even though the agent is the lead of a team of one (before, it was let through; this is a behavior change for `run --agent`). Inside `proposals/` it may create and change only `<its short id>-<slug>.md`, and only while the file is `proposed`; another prefix, `.archive/`, a deletion and an already decided proposal are put back. As for the records, while another run of the project is live, or began and ended during the watch, the change cannot be attributed and is kept; this is best effort, not a guarantee. An ordinary run's other members get the proposals read-only from the write policy alone.

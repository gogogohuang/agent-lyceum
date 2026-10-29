# Write scope

Default rules (everything else in the repo is unrestricted):

| Target | Rule |
|---|---|
| own memory dirs, own `outbox/` | writable |
| own `agents/<self>/`, `shared/common/` (`COMMON.md`, `records/`) | writable by every member |
| another agent's `AGENT.md`, a global `AGENT.md`, repo `CLAUDE.md`/`AGENTS.md` | read-only; the lead (`can_edit_agent_md`) may edit them |
| the run's handoff notes `task-memory/<run-id>/_shared/` | the lead writes; every other agent is read-only |
| other agents' memory/inbox/outbox, `runs/`, config files | not writable |

Enforcement is layered because no single mechanism is complete:

- **Claude Code**: per-run `--settings` with `Edit(...)` rules **plus** the OS sandbox (`allowWrite`/`denyWrite`, `allowUnsandboxedCommands: false`). Without the sandbox, `python -c` and similar bypass Edit rules, so the sandbox is required for the `os` level.
- **Codex**: `-s workspace-write` with `-c sandbox_workspace_write.writable_roots=[...]` (OS-enforced). Codex cannot forbid a single file inside the repo, so repo `CLAUDE.md`/`AGENTS.md` are protected by **post-hoc detection** only.
- **All runtimes**: protected files are hashed before the run; after each wake-up unauthorized changes are reverted, logged, and reported to the lead; what was written is kept in `runs/<run-id>/violations/` first.

**Changes the guard cannot attribute.** `COMMON.md`, the records tree `shared/common/records/` and the team's `AGENT.md` files are shared by all runs of a project. If no agent in a batch of wake-ups may edit such a file, and another run of the same project is live (its run lock is held by a living process) at the start or end of that batch, a change to the file cannot be attributed to this run. The guard then does not revert it, keeps no copy in `violations/`, and sends the lead no mail; the change becomes the new baseline, and the run log records a `protected-change-unattributed` event (plus one console line). Why: another run's lead legitimately edits these files, and reverting that woke this run's lead for nothing. This skips only what the guard cannot attribute: a violation by this run's own agent inside that window is also not reverted, and then only the runtime/OS sandbox above stops it. Per-run files (the run's handoff notes, repo `CLAUDE.md`/`AGENTS.md`) and any change while no other run is live are reverted and reported as before. See [Several runs at once](how-it-works.md#several-runs-at-once).

`doctor` and `run` print every agent's level per category (`os`, `tool-rules`, `post-hoc`, `prompt-only`) and the paths it can write outside the repo. With `dispatcher.strict: true`, a run is refused unless memory, `AGENT.md`, other agents' context and (for non-lead agents) the handoff notes are OS-enforced.

Git in agent worktrees: an agent can write its worktree's `.git` pointer file and its private git dir, which could make git read a config or hooks the agent planted. So every git call the dispatcher makes into an agent's worktree pins the git dir, common dir and work tree recorded when the worktree was made, turns off hooks, fsmonitor, external diff and textconv, and refuses a worktree whose git files were redirected or linked elsewhere, whose HEAD is not its own branch, or that contains a nested repository. Claude additionally may not write those pointer files (`denyWrite`); Codex cannot forbid single files and relies on the pinning alone. Residual risks are listed in [spec 15](specs/15-worktree-git-isolation.md#156-殘留風險). This does not claim the dispatcher can never run code an agent planted. A repository using the `reftable` ref backend is refused in worktree modes.

Known gaps: Claude Code's built-in Edit/Write tools are not sandboxed (covered by the `Edit` rules); Codex MCP tools and hooks run outside its sandbox; `--dangerously-bypass-approvals-and-sandbox` / `danger-full-access` disable everything. With `can_edit_agent_md`, a Codex lead's writable roots widen to whole agent directories.

## Sandbox allowances

`sandbox` on an agent (`write`, `network`, `local_binding`, `unix_sockets`; field reference in [Configuration](configuration.md#sandbox-allowances), design in [spec 25](specs/25-sandbox-allowances.md)) widens the OS sandbox for that agent only, and only when set. It is implemented in 0.28.0; the end-to-end effect of each key in a real wake-up is **unverified**.

- **`write`** adds directories to the agent's write scope, the same list that gives Claude its `Edit` rules, `allowWrite` and `--add-dir`, and Codex its `writable_roots`. Protected paths can never be added, for example: anything inside the config home or the repo, every `AGENT.md`, memory folder, inbox and outbox, `COMMON.md`, the records folder, the run's data, other agents' worktrees and git dirs, the git common dir, the worktrees root, the repo's `CLAUDE.md`/`AGENTS.md`, `~/.claude`, `~/.codex`, and their ancestors. The complete list is in [Configuration](configuration.md#sandbox-allowances); a refused invocation is logged as `sandbox-refused` and is not retried.
- **`unix_sockets`** adds Unix sockets under each listed path, to **bind and to connect**, not only to listen in a test. Anything in that folder is reachable, so keep sockets such as Docker's or ssh-agent's out of it. Claude Code only; Codex gets nothing and `doctor` warns.
- **`local_binding`** (Claude Code only) allows bind and inbound connections on **any local IP**, not only loopback, plus outbound connections to services on localhost. It is not "serve on localhost only". Per the Claude Code docs it has no effect on Linux ([sandboxing](https://code.claude.com/docs/en/sandboxing)). It does not cover Unix sockets.
- **`network`**: per domain on Claude Code; all-or-nothing on Codex (any listed domain opens all hosts).
- **Unchanged:** `allowUnsandboxedCommands` stays `false`, Codex stays in `workspace-write`, and no key gives any agent, the lead included, a way to run outside the sandbox. Non-lead agents never run outside it. (The dispatcher, not an agent, pushes the branch and opens the PR when the lead's accepted `done` asks for it.)
- **Write scope, not read isolation:** these keys widen what an agent may write or connect to. They do not restrict reads, and nothing here keeps an agent from reading another agent's memory.
- **No OS sandbox:** Claude's `write` then widens only the `Edit` tool rules (Bash can bypass them) and the other keys do nothing; on Codex it is prompt-only. A path is checked before each invocation, but a path swapped between the check and the spawn is not defended against; the OS sandbox is the boundary.

**Tests that start child processes.** Under Claude's sandbox, `npm test` fails when `tsx` children cannot open their IPC socket (`listen EPERM .../tsx-<uid>/*.pipe`); the diagnosis is in [Sandbox blocks](sandbox-blocks.md). `unix_sockets: [<your $TMPDIR>/tsx-<uid>]` (resolve `$TMPDIR` yourself; it is not expanded) is the intended fix, but it is **unverified** end to end, and a Claude Code 2.1.89 report says scoped Unix allowances covered connect only ([claude-code#41817](https://github.com/anthropics/claude-code/issues/41817)). The known workaround remains a `NODE_OPTIONS="--import stub.mjs"` stub that turns `net.Server.listen` on `*.pipe` paths into a no-op.

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

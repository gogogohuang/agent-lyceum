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

**Not built in stage 2b-1:** re-checking enrollment at each wake and refusing to wake a slot, `status` reasons, write access to `proposals/`, collecting requests, an approvals CLI, an executor runner. Stage 3 adds request collection: see [Approval request collection](#approval-request-collection-stage-3-not-releasable). The real Claude CLI's acceptance of the new flags, the real sandbox's effect, and Linux are **unverified**; the macOS step-0 measurements are in spec section 8.

## Approval request collection (stage 3, not releasable)

**Not releasable: step 0 unverified** (「非可發布：第 0 步未驗證」). Three things are **UNVERIFIED** and block release: F3 (the user settings layer: `--setting-sources user` still loads `~/.claude/settings.json` for enrolled agents, `src/adapters/claude.ts:13`), Linux, and enforcement by the real OS sandbox. Everything below is what the code does, not evidence that it is safe. Details and the API are in [Approval store API](approval-store-api.md#request-collection-stage-3-not-releasable).

### Request files

- **Where.** An enrolled agent writes plain-text requests into its slot's `proposals/` directory: `<home>/requests/projects/<project>/<run-id>/<slot>/proposals/` (`src/approval-paths.ts:57,62`). It is granted as one more writable directory and the path is named in the system and user prompt (`src/prompt.ts` `approvalRequestsBlock`). <!-- S3-dependent -->
- **Who gets it.** Only a claim wake of an enrolled agent: the first call, every retry and every fallback, solo included. A lead, tidy, verify, format or `call` wake never gets the directory, the grant or the prompt text. <!-- S3-dependent -->
- **File name.** `^(?!\.)[A-Za-z0-9._-]{1,64}\.req$` (`src/approval-id.ts:19`). Other names are ignored.
- **Content.** Header, empty line, payload. The header has at most two lines, `executor: <name>` (required, must be a registered executor) and `summary: <text>` (optional, at most 300 code points), at most 2048 bytes including the empty line. The payload is limited by the executor's `max_payload_bytes` (default 4096, at most 65536); a file over 67584 bytes is refused before parsing. The whole file must be UTF-8 text with no control characters other than LF and TAB, no format, separator or invisible characters (U+3000 is allowed); nothing is sanitized, a bad file is recorded as denied (`src/approval-request.ts:9-70`, `src/approval-executors.ts:32-34`).
- **Not a command.** A collected request is only stored for a later review. Nothing runs because an agent wrote it.

### What the dispatcher does

- **Collection.** After a wake's output is routed, each enrolled slot's `proposals/` is moved whole to `collected/<seq>/` and replaced by a new empty directory; the requests in it become records under `<home>/approvals/`. Sequence numbers only grow (`collected.seq` high-water file); an empty directory is never moved, so no sequence is used for it. `resume` collects what an interrupted run left. <!-- S3-dependent -->
- **Record commit point.** A request exists once its `record.json` is linked into place; it is never overwritten. `collected/<seq>.done` is written last, so a crash before it only repeats work, and the same request gets the same id (`src/approval-collect.ts:20-26`).
- **Failed or cancelled attempt.** The slot's `proposals/` is moved to `parked/<attempt-id>/` before the attempt is finished. Parked requests are never collected and never used as redo drafts (`src/approval-rotation.ts` `Park`; spec 4.4); the agent must ask again. If they cannot be set aside, the slot is not called again in that run (the run ends `agent_failed`) and the leftover is parked at the next `resume`. <!-- S3-dependent -->
- **Resume after a crash.** `resume` parks a started attempt's directory before it marks the attempt failed, and the directory of a claim it just turned `abandoned` before saving that state. A slot where that fails is left as it was and is not woken. <!-- S3-dependent -->
- **`full_writable`.** The record's `origin.full_writable` is the set of writable paths the slot has *when the request is collected*. After a crash, a resume records the grant at that later collection, not the original wake's. It is shown for review only and is not compared with anything. <!-- S3-dependent -->
- **Rejection and quota.** Over-limit, malformed or not-allowed requests become `denied` records with a fixed reason (`bad_content`, `bad_header`, `bad_executor`, `too_large`, `not_allowed`, `quota`, `not_regular`, `scan_limit`). A small counter file per project (or call) and role counts the denied requests; while it is below 100 each one also keeps a full record, after that it is only counted. The count is approximate (read, add one, rewrite, no lock across passes). The pending quota (`max_pending` per executor, `max_total_pending`) is soft: it is counted once per slot pass, so passes of different slots can exceed it together. At most `max_scan_entries` (default 200) files per directory are read, oldest first; the rest are counted in one `scan_limit` record (`src/approval-collect.ts:61,320-385`).

### Operator actions

Every collection problem is logged to `log.jsonl` as `approval_collect` with fixed fields (`slot`, `op`, `class`, optional `seq`, `id`, `count`); no path, error text, file name or payload is logged (`src/approval-collect.ts:34-38`). The slot is not woken until it is fixed; other slots go on. Human `status` shows a fixed reason for the skipped slot (today "request directory is unsafe" or "earlier approval output is waiting", `src/approval-wake-gate.ts:59-60`; the stage 3 plan rewords the first and adds collected counts, which are not described here until built).

| `class` | Meaning | What to do |
|---|---|---|
| `held` | `<slot>/.coord` exists: another run holds the slot, or a crash left it. It is never taken over | Stop **every** run of the project, check with `agent-lyceum status` that none is live (and no `requests gc`; it does not exist yet), then remove the stale `.coord` directory by hand |
| `not_directory`, `symlink` | `proposals/`, `collected/` or a parent is a link, file or other non-directory | Make them plain directories again; do not follow links |
| `missing` | Declared in the log type but no code path in `src/approval-collect.ts` returns it in this version (a missing `proposals/` is simply recreated) | Nothing to do |
| `corrupt` | `collected.seq`, the denied counter or a record cannot be parsed | Fix or restore that file by hand; the slot stays blocked until then |
| `unsupported` | The file system refuses hard links (`ENOTSUP`, `EOPNOTSUPP`, `EXDEV`, `ENOSYS`, `EPERM` on link) | Use a file system with hard links for the config home |
| `permission` | `EACCES` or `EPERM` on another call | Fix the owner and mode of the approval home |
| `race` | A file or directory changed or vanished while it was read | Retried at the next pass; if it repeats, find what is changing the directory |
| `mismatch` | A stored record for the same request has a different payload | Do not edit; keep the files and report it |
| `budget` | See below | See below |
| `cancelled` | The run was cancelled before this slot was collected | `resume` |
| `io` | Any other error | Check the disk and permissions, then `resume` |

**Work budget.** One pass over a slot may spend 65536 units: one per file system call and one per directory entry (`SCAN_WORK_BUDGET`, `src/approval-budget.ts:19`). A valid listed file costs a directory entry plus an `lstat`; a file with an invalid name costs one unit and is not stat'ed. On overflow the pass stops at once: no `.done`, no `scan_limit` record, nothing deleted or moved; records already published stay and are adopted next time. The slot is not woken (`RESIDUAL_OUTPUT`, or `UNDETERMINABLE` when the overflow happened counting the store's existing records). The budget bounds work, not time: one call on a hung file system can still block. **Starvation:** a `collected/<seq>` that always exceeds the budget, or keeps changing, blocks its slot until you act: stop all runs of the project, inspect `collected/<seq>/` of that slot, move the files you do not want to a place outside the approval home, then `resume`. A store with so many records that the quota count alone exceeds the budget blocks every enrolled slot; nothing in stage 3 removes records (`gc` is not built).

### Residual risks, not implemented, unverified

- **Residual process or file descriptor (spec 4.4).** A background process an agent managed to leave behind can write into the new `proposals/` after the move; that is seen at the next pass and can only add requests (quota-limited). A descriptor it holds on a moved file can still change that file inside `collected/`; the collector only checks that the file kept its device and inode while it was read, not that its content stayed the same. Copies already stored in `approvals/` are not changed.
- **Write scope is not read isolation.** Granting `proposals/` only governs writing. Nothing here stops an agent from reading other agents' files or requests; do not treat requests as confidential (see the top of this page).
- **Not implemented:** approving, executing, feedback, `requests gc`/`approvals gc`, and collection for `call`. Instances (`<role>--N`) are not collected yet. <!-- S3-dependent -->
- **UNVERIFIED:** F3, Linux, enforcement by the real sandbox, and the real Claude CLI's use of the `proposals/` grant. Do not enable `executors.yaml` outside a throwaway home.

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

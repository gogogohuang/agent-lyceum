# Sandbox blocks: child-process tests and file deletion / git revert

Diagnosis for task c0f62d, part 1. No `src/` change. Observed on 2026-10-27, macOS (Darwin 27), `claude` 2.1.311.

## Where the evidence comes from

This report was written by a Claude agent woken by agent-lyceum, so the probes below ran **inside the generated agent sandbox** of a real run, not in a lookalike:

- Generated settings: `runs/20261027T031319310Z-…/agents/runtime-debugger/claude-settings.json` (read-only), built by `buildClaudeSettings` (`src/adapters/claude.ts:25-50`). Its `sandbox` block:

  ```json
  { "enabled": true, "allowUnsandboxedCommands": false,
    "filesystem": {
      "allowWrite": ["<worktree>/runtime-debugger", "<agents>/runtime-debugger/memory", "<task-memory>/runtime-debugger",
                     "<run>/mail/outbox/runtime-debugger", "/Users/…/agent-lyceum/.git/worktrees/runtime-debugger3"],
      "denyWrite": [139 entries, incl. "<worktree>/runtime-debugger/.git",
                    ".git/worktrees/runtime-debugger3/{commondir,config.worktree,gitdir}"] } }
  ```

  There is no `sandbox.network` key at all (`src/adapters/claude.ts:42-49`). `permissions.allow` is `["Bash","Read","Glob","Grep","Edit(//<worktree>/**)", …]`; `permissions.deny` holds only `Edit(...)` rules (`src/adapters/claude.ts:11-22,34-38`).
- The effective sandbox of this wake, as reported by Claude Code to the agent, is that `allowWrite` **plus** `$TMPDIR` (`/tmp/claude-501`), `/tmp/claude`, `~/.npm/_logs`, the user's own `~/.claude/settings.json` entry (`/Users/…/line_taxi/.git`) and **`/Users/…/Documents/p/project/agent-lyceum/.git`** (the git common dir). Neither the generated settings nor `~/.claude/settings.json` (`{"network":{"allowedDomains":[…]},"filesystem":{"allowWrite":["…/line_taxi/.git"]}}`) lists that common dir, so Claude Code adds it itself for a worktree cwd. Source of that behaviour: observed only, not found in docs (unverified as a documented contract).

So "blocked in my sandbox" = "blocked in the generated Claude agent sandbox" for the probes below. Codex was **not** run (only `codex --version` was tried; it printed `WARNING: … could not create PATH aliases: Operation not permitted`), so every Codex statement is from code and is marked unverified.

## (a) Tests that spawn child processes (`npm test` → `tsx` children)

**Symptom** (project lesson `sandbox-pipe-stub-for-cli-tests`): ~77 tests fail with `listen EPERM .../tsx-501/*.pipe`. `tsx` opens an IPC server on a Unix socket in the temp dir.

**Repro in the agent sandbox** (`$TMPDIR/probe.mjs`, removed after):

```
$ node probe.mjs   # net.createServer().listen("$TMPDIR/probe-<pid>.pipe"), then listen(0,"127.0.0.1")
unix listen: EPERM listen EPERM: operation not permitted /tmp/claude-501/probe-60941.pipe
tcp 127.0.0.1:0 listen: EPERM listen EPERM: operation not permitted 127.0.0.1
```

`/tmp/claude-501` is writable (it is `$TMPDIR` in the effective allow list), so a filesystem rule is not what refuses the socket; it is the sandbox's network policy refusing the bind/listen. Spawning the child itself is not blocked (every `node`/`git` call in this report is a spawned process).

| Layer | Verdict | Evidence |
| --- | --- | --- |
| Claude OS sandbox, network (no `allowLocalBinding`, no Unix-socket allowance) | **confirmed** | probe above; `src/adapters/claude.ts:42-49` emits no `sandbox.network` |
| Claude OS sandbox, filesystem | ruled out | socket path is in a writable dir and still EPERM |
| `permissions.allow/deny` (`Edit(...)`) | ruled out | rules are Edit-only, `Bash` is allowed (`src/adapters/claude.ts:29,37`) |
| post-wake guard (`src/guard.ts`) | ruled out | runs after the wake and only compares protected files (`src/guard.ts:72-78`), cannot cause an EPERM at runtime |
| worktree protections (`src/worktree.ts`) | ruled out | unrelated to sockets |
| Codex `workspace-write` | unverified | not run. Codex's workspace-write sandbox is documented to disable network by default; whether Unix-socket listen is included was not checked |

**Minimal allowance (Claude):** the reviewed Claude Code 2.1.311 macOS profile evidence distinguishes IP sockets from Unix sockets. In [`generateSandboxProfile`](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/src/sandbox/macos-sandbox-utils.ts), `sandbox.network.allowLocalBinding: true` emits:

```scheme
(allow network-bind (local ip "*:*"))
(allow network-inbound (local ip "*:*"))
(allow network-outbound (remote ip "localhost:*"))
```

These are IP rules: local bind/inbound is not restricted to loopback, and they do **not** cover Unix sockets. Unix sockets need `sandbox.network.allowUnixSockets: ["<dir>"]` (path-scoped bind and connect under the subpath) or `allowAllUnixSockets`. Version matters: [anthropics/claude-code#41817](https://github.com/anthropics/claude-code/issues/41817) reports that scoped Unix allowances in 2.1.89 covered connect only. This is source/reviewer evidence; the end-to-end effect of these settings in an agent-lyceum wake remains **UNVERIFIED**.

The lead's decision for spec 25 is to add `local_binding` (TCP) and `unix_sockets: [paths]`, never an allow-all Unix option. Local binding expands IP bind/inbound access; a Unix path allowance permits both binding and connecting under that path, so paths must exclude sensitive sockets such as Docker or ssh-agent sockets. The existing workaround (`NODE_OPTIONS=--import stub.mjs` no-op on `*.pipe`) needs no allowance.

## (b) Deleting files, `git restore`, `git revert` in the agent's worktree

**Repro in the agent sandbox** (worktree left clean, `git status --short` empty afterwards):

```
$ rm LICENSE && echo rm-ok              -> rm-ok        (git status: " D LICENSE")
$ git restore LICENSE && echo restore-ok -> restore-ok  (status clean)
$ touch probe.tmp && rm probe.tmp        -> new-rm-ok
$ git rev-parse --git-common-dir --git-dir
/Users/…/Documents/p/project/agent-lyceum/.git
/Users/…/Documents/p/project/agent-lyceum/.git/worktrees/runtime-debugger3
$ echo lyceum-probe | git hash-object -w --stdin
d7697afa8cc2e24a7f463231dd4c5e813299f0d0          (a loose object written into the common .git/objects)
$ git revert --no-commit HEAD; git revert --abort   -> no error, status clean
```

**Probe side effect:** the `git hash-object -w` command above ran against the real shared common repository and left unreachable loose blob `d7697afa8cc2e24a7f463231dd4c5e813299f0d0`. It did not create a ref. The lead decided to leave it in place: normal `git gc` pruning removes it when eligible. This was a write outside a disposable repository; future write probes must use a disposable repo under `$TMPDIR`. No such probe was repeated for this revision.

A committing `git revert` was not run (agents must not commit). It needs writes to the common dir's `objects/` and `refs/heads/agent-lyceum/<run>/<agent>`; the `hash-object -w` write shows `objects/` is writable here. Ref writes were not probed (would touch the user's main repo refs) — unverified, but they sit under the same allowed common dir.

| Layer | Verdict | Evidence |
| --- | --- | --- |
| Claude OS sandbox, filesystem | **ruled out** for rm / restore / revert in the generated Claude sandbox | probe above; worktree root and its git dir are in `allowWrite` (`src/policy.ts:126-129`, `src/adapters/claude.ts:46`); the common `.git` is added by Claude Code itself (observed) |
| `permissions.deny` `Edit(...)` | ruled out for normal files | deny covers only protected paths: other agents' dirs, AGENT.md/CLAUDE.md/AGENTS.md copies, the worktree's `.git` file and `commondir`/`config.worktree`/`gitdir` (`src/policy.ts:141-162`). Deleting or restoring **those** files is blocked by design |
| post-wake guard | ruled out for normal files | only `protectedFiles` and `recordsDir` are compared and restored (`src/guard.ts:72-78,112-137`); a deleted protected file comes back after the wake, logged in `violations/` |
| worktree link protections | ruled out for rm/restore/revert | `assertWorkspaceIntact` (`src/worktree.ts:102-151`) refuses symlinked/hard-linked git files, a rewritten `commondir`, or a `HEAD` not on the worktree branch. `revert`/`restore` keep `HEAD` on the branch; a `git checkout <other>` / detached HEAD would make the next wake refuse the worktree |
| Codex `-s workspace-write` + `writable_roots` | **unverified, likely blocks a committing `git revert`** | `codexWritableRoots` (`src/adapters/codex.ts:7-12`) passes memory/outbox/`ws.gitDir` but not the common `.git`; nothing adds it, so `objects/` and `refs/` writes are probably refused. Codex is also reported to keep `.git` read-only inside writable roots (unverified). `rm` and `git restore` touch only the worktree and `ws.gitDir/index`, both writable, so they should work (unverified) |

**Conclusion (b):** for Claude agents nothing in agent-lyceum blocks delete/restore/revert of ordinary worktree files in this run's setup; a report of being blocked is most likely (1) a protected path (by design), (2) a Codex agent committing (common dir not writable), (3) a non-worktree run (legacy layout) whose `allowWrite` is `project.dir` and whose `.git` is not auto-added — not probed, unverified, or (4) a `git` command that needs the network. These need the original error text to tell apart.

**Minimal allowance if commits must work under Codex:** add the git common dir's `objects/` and the agent's own `refs/heads/agent-lyceum/<run>/<agent>` (plus `logs/`) to `writable_roots`. Risk: `objects/` is shared by every worktree and the main checkout; write access lets an agent add objects (harmless) but a writable `refs/` parent would let it move other branches, so it must be scoped to its own ref path — and git's packed-refs / ref lock files sit at the `refs/` root, so a per-ref allowance may not be enough (unverified). Prefer keeping "agents do not commit; the dispatcher snapshots" as the rule.

## Open points

- Codex probes need a run outside this sandbox (`codex exec -s workspace-write -c 'sandbox_workspace_write.writable_roots=[…]'` with the args from `buildCodexInvocation`).
- End-to-end effect of the Claude network settings remains UNVERIFIED; whether the common-dir auto-add is documented remains unknown.
- The original agent error text for (b) was not available; ask for it.

## Dimension checks

- **Compatibility & Format — checked:** IP versus Unix socket scope and the 2.1.89/2.1.311 version distinction are documented above; Codex runtime behavior remains unverified.
- **File & Process Safety — checked:** ordinary file operations and protected-path boundaries are separated above; the real-common-repo blob side effect is disclosed. Future write probes use disposable repos.
- **Concurrency & Recovery — justified skip:** this revision corrects a sandbox allowance report; no concurrent run, stale PID/lock, timeout, retry, or recovery symptom was supplied, and no concurrent-run probe was performed.
- **Platform & Operability — checked:** observations are limited to macOS Darwin 27 and Claude 2.1.311; Linux and Codex effects are unverified.
- **Testability & Maintainability — checked:** the report retains minimal socket/file repro commands and identifies the no-allowance stub workaround; this revision runs only the documentation check, with no new runtime or real-data write probes.
- **Observability & Diagnosability — checked:** exact EPERM output and generated-settings evidence are recorded above; the original error for (b) is still missing, preventing a confirmed diagnosis of that report.

**Architect needed: yes — handled in spec 25.** The suggested direction is explicit TCP and path-scoped Unix allowances; the blast radius is sandbox network access for configured agents, with end-to-end validation still required. No product code is changed here.

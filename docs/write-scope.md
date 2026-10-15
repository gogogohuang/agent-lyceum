# Write scope

Default rules (everything else in the repo is unrestricted):

| Target | Rule |
|---|---|
| own memory dirs, own `outbox/` | writable |
| any `AGENT.md`, `COMMON.md`, repo `CLAUDE.md`/`AGENTS.md` | read-only; the lead (`can_edit_agent_md`) may edit them |
| the run's handoff notes `task-memory/<run-id>/_shared/` | the lead writes; every other agent is read-only |
| other agents' memory/inbox/outbox, `runs/`, config files | not writable |

Enforcement is layered because no single mechanism is complete:

- **Claude Code**: per-run `--settings` with `Edit(...)` rules **plus** the OS sandbox (`allowWrite`/`denyWrite`, `allowUnsandboxedCommands: false`). Without the sandbox, `python -c` and similar bypass Edit rules, so the sandbox is required for the `os` level.
- **Codex**: `-s workspace-write` with `-c sandbox_workspace_write.writable_roots=[...]` (OS-enforced). Codex cannot forbid a single file inside the repo, so repo `CLAUDE.md`/`AGENTS.md` are protected by **post-hoc detection** only.
- **All runtimes**: protected files are hashed before the run; after each wake-up unauthorized changes are reverted, logged, and reported to the lead; what was written is kept in `runs/<run-id>/violations/` first.

`doctor` and `run` print every agent's level per category (`os`, `tool-rules`, `post-hoc`, `prompt-only`) and the paths it can write outside the repo. With `dispatcher.strict: true`, a run is refused unless memory, `AGENT.md`, other agents' context and (for non-lead agents) the handoff notes are OS-enforced.

Git in agent worktrees: an agent can write its worktree's `.git` pointer file and its private git dir, which could make git read a config or hooks the agent planted. So every git call the dispatcher makes into an agent's worktree pins the git dir, common dir and work tree recorded when the worktree was made, turns off hooks, fsmonitor, external diff and textconv, and refuses a worktree whose git files were redirected or linked elsewhere, whose HEAD is not its own branch, or that contains a nested repository. Claude additionally may not write those pointer files (`denyWrite`); Codex cannot forbid single files and relies on the pinning alone. Residual risks are listed in [spec 15](specs/15-worktree-git-isolation.md#156-殘留風險). This does not claim the dispatcher can never run code an agent planted. A repository using the `reftable` ref backend is refused in worktree modes.

Known gaps: Claude Code's built-in Edit/Write tools are not sandboxed (covered by the `Edit` rules); Codex MCP tools and hooks run outside its sandbox; `--dangerously-bypass-approvals-and-sandbox` / `danger-full-access` disable everything. With `can_edit_agent_md`, a Codex lead's writable roots widen to whole agent directories.

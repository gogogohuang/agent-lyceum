# Layout

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
    ├── task-memory/<run-id>/{<agent>/, _shared/}   # per-run memory, never shared between runs; _shared = the lead's handoff notes for follow-ups
    └── runs/<run-id>/{task.md, log.jsonl, state.json, result.md, done-<n>.md, followups/<n>.md, snapshots/, agents/, mail/{inbox,outbox}/<agent>/}
```

`team.yaml` defines reusable agents; `project.yaml` picks the team and overrides fields. Objects merge field by field, arrays (`can_message`, `owns`) are replaced. Relative paths resolve against the folder of the file they are written in; `~` is allowed.

```yaml
# project.yaml
dir: ~/code/web-app
team: { lead: lead }
dispatcher: { max_rounds: 0, max_parallel: 1, max_concurrent_runs: 1, wake_timeout_sec: 600, retry: 2, strict: false, workspace_mode: auto, log_max_bytes: 8388608 }
agents:
  lead:      { resume: true, can_message: all, can_edit_agent_md: true }
  fe-member: { runtime: codex, can_message: [lead], owns: ["src/web/**"] }
  qa-member: { can_message: [lead], owns: ["tests/**"] }
  pm:        { can_message: [lead], allow_web: fetch }   # pm may search and read pages; the others have no web tools
```

Agent fields: `runtime` (`claude-code`|`codex`; optional when `model` is recognizable: `opus`/`sonnet`/`haiku`/`claude-*` → Claude Code, `gpt-*`/`o3`/`*codex*` → Codex; precedence: project runtime > project model > global runtime > global model), `model`, `effort` (Claude Code: `low`|`medium`|`high`|`xhigh`|`max` via `--effort`; Codex: `minimal`|`low`|`medium`|`high`|`xhigh` via `model_reasoning_effort`; unset = CLI default), `agent_md`, `memory.global` / `memory.project`, `resume`, `can_message` (`all` or list; default `[lead]`, lead default `all`), `can_edit_agent_md` (default only the lead), `can_ask_user` (may send `type: ask` mail to you and pause the run for an answer; default only the lead), `allow_web` (`none`|`search`|`fetch`; what the agent may use of the web, off unless set; see "Web access" below), `owns` (repo globs).

Rules checked by `doctor`: ≥ 2 agents (the lead and one member; the template has three), the lead is a listed agent, every agent has a runtime (explicit or inferred from `model`) and an existing `AGENT.md`, `effort` is valid for the agent's runtime (warning if `runtime` contradicts a recognizable `model`), `can_message` targets exist, memory dirs don't overlap, and with `max_parallel > 1` every non-lead agent needs non-overlapping `owns` and the repo must be a git repository, and with `max_concurrent_runs > 1` the repo must be a git repository and `workspace_mode` must not be shared.

# Layout

```
~/agent-lyceum-config/
├── team.yaml                         # global agent library
├── agents/<agent>/{AGENT.md, memory/}  # global persona + cross-project memory
├── calls/<call-id>/{task.md, log/, result.md}   # one folder per `call` (outside any project), plus .lock-<agent>
└── projects/<project>/
    ├── project.yaml                  # team, repo dir, overrides
    ├── agents/<agent>/{AGENT.md?, memory/}   # project-level persona (optional) + project memory
    ├── shared/common/{COMMON.md, records/{decisions,lessons}/<id>.md, records/.archive/}   # lead-maintained, read-only for the rest; one file per decision/lesson (frontmatter: status, date, run?, supersedes?, title); .archive = tidy output, never shown in prompts
    ├── locks/<run-id>.json           # held while that run is active
    ├── task-memory/<run-id>/{<agent>/, _shared/}   # per-run memory, never shared between runs; _shared = the lead's handoff notes for follow-ups
    └── runs/<run-id>/{task.md, log.jsonl, state.json, result.md, done-<n>.md, followups/<n>.md, snapshots/, agents/, mail/{inbox,outbox}/<agent>/}
```

`team.yaml` defines reusable agents; `project.yaml` picks the team and overrides fields. Objects merge field by field, arrays (`can_message`) are replaced. Relative paths resolve against the folder of the file they are written in; `~` is allowed.

```yaml
# project.yaml
dir: ~/code/web-app
team: { lead: lead }
dispatcher: { max_rounds: 0, wake_timeout_sec: 600, retry: 2, strict: false, log_max_bytes: 8388608 }
agents:
  lead:      { resume: true, can_message: all, can_edit_agent_md: true }
  fe-member: { runtime: codex, can_message: [lead] }
  qa-member: { can_message: [lead] }
  pm:        { can_message: [lead], allow_web: fetch }   # pm may search and read pages; the others have no web tools
```

Agent fields: `runtime` (`claude-code`|`codex`; optional when `model` is recognizable: `opus`/`sonnet`/`haiku`/`claude-*` → Claude Code, `gpt-*`/`o3`/`*codex*` → Codex; precedence: project runtime > project model > global runtime > global model), `model`, `effort` (Claude Code: `low`|`medium`|`high`|`xhigh`|`max` via `--effort`; Codex: `minimal`|`low`|`medium`|`high`|`xhigh` via `model_reasoning_effort`; unset = CLI default), `agent_md`, `memory.global` / `memory.project`, `resume`, `can_message` (`all` or list; default `[lead]`, lead default `all`), `can_edit_agent_md` (default only the lead), `can_ask_user` (may send `type: ask` mail to you and pause the run for an answer; default only the lead), `allow_web` (`none`|`search`|`fetch`; what the agent may use of the web, off unless set; see "Web access" below).

Rules checked by `doctor`: ≥ 2 agents (the lead and one member; the template has three), the lead is a listed agent, every agent has a runtime (explicit or inferred from `model`) and an existing `AGENT.md`, `effort` is valid for the agent's runtime (warning if `runtime` contradicts a recognizable `model`), `can_message` targets exist, and memory dirs don't overlap. Settings removed in the zero-config concurrency change (see [Upgrading](upgrading-run-v2.md)) still load and only produce a warning.

Concurrency needs no configuration: in a git repo with a commit every run and every agent gets its own worktree; otherwise the run works directly in the folder, one agent at a time. See [How a run works](how-it-works.md#several-runs-at-once).

## Fallback models

When a model keeps failing for a temporary reason, a run can switch to a backup instead of stopping; see [When a wake-up fails](how-it-works.md#when-a-wake-up-fails). Backups are an ordered list, `fallback`, of entries with these fields:

- `model`, `runtime`, `effort`, all optional, but an entry needs `model` or `runtime`. A missing `runtime` is inferred from `model` (same rule as for agents), and if that finds nothing, the agent's own runtime is used. A runtime without a `model` means that runtime's default model. `effort` must be valid for the entry's runtime. An entry without `effort` runs at its runtime's CLI default: the primary's `effort` is not inherited.

Where to write it, from the strongest to the weakest:

1. `agents.<name>.fallback` in `project.yaml`;
2. `fallback` of the agent in `team.yaml`;
3. `dispatcher.fallback` in `project.yaml`, shared by every agent that has none of its own;
4. nothing: the agent has no backup.

`fallback: []` on an agent means no backup, even when `dispatcher.fallback` is set. `dispatcher.fallback_cooldown_sec` (default `300`) is how long a model that hit `rate_limit` or `quota` is skipped in this run; `0` means it is never cooled down.

```yaml
# project.yaml
dispatcher:
  fallback_cooldown_sec: 300
  fallback:                                   # backups for every agent without its own
    - { model: sonnet }                       # runtime inferred: claude-code
    - { runtime: codex, model: gpt-5, effort: high }
agents:
  reviewer: { fallback: [] }                  # this one never switches
  pm:       { fallback: [{ runtime: claude-code, model: haiku }] }
```

Config fails to load (`doctor` and `run` report an error) when:

- an entry has neither `model` nor `runtime`, or its runtime cannot be worked out;
- an entry's `effort` is not valid for its runtime;
- an entry is the same runtime and model as the agent's own, for the agent's own list. A shared `dispatcher.fallback` that contains an agent's own model is not an error: that entry is skipped for that agent;
- the backup would protect less than the primary: for memory, `AGENT.md`, other agents' context, the handoff notes or the repo's `CLAUDE.md`/`AGENTS.md`, the backup's enforcement is `prompt-only` where the primary's is stronger. For example, without an OS sandbox `claude-code` falls back to tool rules, but a `codex` backup would be prompt-only, so that switch is refused. See [Write scope](write-scope.md).

`doctor --resolved` shows the effective chain and where it came from once any agent has one.

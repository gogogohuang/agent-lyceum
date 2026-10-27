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

## Parallel instances

A lead can run one member as several instances at once; see [Parallel instances of one member](how-it-works.md#parallel-instances-of-one-member). The only setting is optional:

```yaml
# project.yaml
dispatcher:
  max_instances: 2   # optional, 1–8; unset = 4; 1 = no parallel instances
```

- `max_instances` is the most instances one member can have in a run. It is `1`–`8` (a whole number); anything else fails to load and names `dispatcher.max_instances`. It is not shown by `doctor --resolved` unless you write it. (Spec 23.4, 23.13)
- The effective cap is 1 whatever you set when the run is not in worktree mode (see [How a run works](how-it-works.md#several-runs-at-once)), for the lead, for a solo run, for a run that uses the legacy mailbox layout, and for a member whose name is not a valid branch name. Two cases lower the cap instead of setting it to 1: a configured agent whose name an instance would get (see Names), and, in a given run, an instance that could write the member's shared memory (below). Instances are checked from 2 upward and the cap stops just before the first one that collides or conflicts (cap `k-1`). (`instanceCap` in `src/instances.ts`)
- **Mixed versions:** older binaries reject a `project.yaml` that contains `dispatcher.max_instances` ("Unrecognized key"), like any new key, and cannot see a run that has used instances (state `schema_version: 3`); see [Upgrading](upgrading-run-v2.md#parallel-instances-run-state-v3). If you switch between versions, leave the key out (the default is 4). (23.4, 23.10)
- **Memory paths:** a member's `memory.global` / `memory.project` must not be inside, or contain, the run data folders (`task-memory/`, `runs/`, `worktrees/`, the repo's git dir), because the member's other instances write there. The cap drops only in a run where the shared memory actually overlaps a writable path of that instance (its worktree, git dir or run folders): the check is made per run and per instance, and a conflicting instance is not opened (cap `k-1`). `doctor` checks more broadly and its warning is advisory: a certain conflict (the memory contains a folder) is worded "runs one task at a time", a memory inside one of those folders is worded "may prevent extra instances for some runs". A run that already has instances is refused by `resume` if one of them would now be able to write the shared memory. Other `doctor` lines about instances (all under the subject `instances`): a warning when you wrote `max_instances` above 1 but runs here take turns in the checkout; an info line when a member's name is not a valid branch name; for a member on Codex without an OS sandbox, an info line (a warning if you wrote `max_instances`) saying that only the member itself writes its memory and its other instances are only told not to. (`src/instance-containment.ts`, `src/instances.ts`, `src/doctor-instances.ts`)
- **Names:** a configured agent named like an instance (`frontend--2` when `frontend` is also a role) limits `frontend` to fewer instances and gets a `doctor` warning that names the colliding agent. (`src/doctor-instances.ts`)

### Lead AGENT.md guidance for parallel tasks

When the feature is available the harness adds a `## Parallel tasks` section to the lead's system prompt. `init` also puts a short rule into the lead persona it creates. It does not change existing `AGENT.md` files: the text the harness adds is `PARALLEL_SECTION` in `src/prompt.ts`, and the line `init` writes is `LEAD_PARALLEL_HINT` in `src/scaffold.ts`. To give your own lead a similar rule, the section below is an example you can adapt (a shorter paraphrase, not the exact harness text). (23.12)

```markdown
## Parallel tasks
- Mark a task `parallel: true` only when it is independent of the other open tasks and changes different files.
- Before sending tasks you want in parallel, list in each task's `## Scope` the files it will touch. If two lists overlap, do not mark them parallel.
- Work on shared components, types, routes, configuration or design tokens goes first, alone and without the flag; send the dependent tasks after it is integrated.
- Send each parallel task as its own new `task` (not a reply). Instance 1 keeps the member's name; the others are `<member>--2`, `<member>--3`.
- Send revisions as a reply (`reply_to`) to the mail of the instance that did the work. An instance whose work is blocked takes no new task until that work is in the repo: reply to the failure about it to redo it.
- After parallel work is back, have one member type-check and test the combined result before you send `done`.
```

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

## Model tiers

An agent's `model` can be a ceiling instead of a fixed choice: the lead marks a task `tier: low|mid|high` and the dispatcher wakes the member on a cheaper model of the same runtime, never above its `model`. See [Model tiers per task](how-it-works.md#model-tiers-per-task) for how a tier is chosen and applied. (Spec 24.1)

```yaml
# team.yaml (global) or projects/<name>/project.yaml
model_tiers:
  claude-code: [claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5]   # lowest → highest
  codex: [gpt-6.1-mini, gpt-6.1-sol]
agents:
  node-engineer: { model: claude-opus-5-5 }    # tiers: haiku, sonnet, opus
  docs-writer:   { model: claude-sonnet-5-5 }  # tiers: haiku, sonnet (ceiling = sonnet)
  cli-reviewer:  { model: gpt-6.1-sol }        # tiers: gpt-6.1-mini, gpt-6.1-sol
```

- **Where and merging:** `model_tiers` is a top-level key with one list per runtime (`claude-code`, `codex`), ordered lowest to highest. It may be written in `team.yaml` and in `project.yaml`. For each runtime the project's list replaces the team's whole; `model_tiers: { codex: [] }` in `project.yaml` turns the Codex ladder off for that project. (24.2 D-01, 24.3)
- **`model` is the ceiling:** an agent can use the ladder entries from the lowest up to and including its `model`; anything above is never used. The `model` must be on its runtime's ladder. An agent without a `model`, or whose `model` is the lowest entry, has nothing to lower and runs as before. (D-02, 24.3.3)
- **Runtimes stay apart:** an agent only moves on the ladder of its own runtime. A reviewer on the other runtime than the member it reviews is unaffected; tiers never switch runtime. `effort` is not tiered: the agent's setting is used at every tier. (24.1, D-09)
- **Mapping:** with `n` usable entries `A` (lowest first, `A[n-1]` = the ceiling), `low` = `A[0]`, `high` = `A[n-1]`, `mid` = `A[floor(n/2)]`, so `mid` rounds up when `n` is even. (D-03, 24.4)

  | usable entries | `low` | `mid` | `high` |
  |---|---|---|---|
  | 1 | 1st | 1st | 1st (no tiers apply) |
  | 2 | 1st | 2nd | 2nd |
  | 3 | 1st | 2nd | 3rd |

- **Off by default:** no ladder, or a task without `tier`, means the member's own `model`, exactly as before. The lead's own model is never tiered. (24.1)

Config fails to load (`doctor` and `run` report an error) when: (24.3.4)

- a ladder entry is not a model of that runtime (`model_tiers.<rt>[<i>]: "<m>" is not a <rt> model ...`);
- a ladder lists the same model twice;
- an agent's `model` is not on its runtime's ladder (`Agent "<a>": model "<m>" is not on model_tiers.<rt> ...`). Add it to the ladder, or set `model_tiers.<rt>: []` in `project.yaml`.

`doctor` warns when an agent has no `model` (the ladder does not apply to it), and when no member can run below its `model` (tiers have no effect).

`doctor --resolved` lists `model_tiers.<runtime>` with the file it came from, and `agents.<name>.model_tiers` (the entries that agent can use). Neither line appears when no ladder is set. (24.9)

**Mixed versions:** older binaries refuse a `team.yaml` or `project.yaml` that contains `model_tiers`; see [Downgrading](../README.md#downgrading). (24.3.2, 24.13 R-4)

**Lead guidance:** when at least one member can run below its `model`, the harness adds a `## Task tiers` section to the lead's system prompt; without a ladder the prompt is unchanged. A resumed Claude lead may keep its old system prompt, so a ladder added mid-run may not reach it (unverified). (24.10)

## Saving tokens

Each wake-up re-reads the agent's whole context, so the number of wake-ups is the main cost of a run. The user measured this over 3 runs: about 156k output tokens against about 12.5M cache-read tokens, with each wake-up re-reading roughly 300k tokens of context. In one run, 6 of 13 rounds were lead re-dispatch or receive wakes, and for a one-line change the code review, docs review, QA and QA review ran; QA plus its review (about 14.6k output tokens) cost twice the implementation. These are one user's measurements, not a benchmark.

### Lead prompt rules

The lead's prompt has a lead-only `## Keeping wake-ups few` section. In summary, it tells the lead to:

- send all independent work in the same wake-up (for example an implementation and its matching docs), and decide once when the replies are back;
- skip the QA layer (the verification role and its reviewer) for a small fix: a few lines, a reproduction test that failed before and passes after, and an approving code review. Send QA for large, cross-module or user-visible changes;
- use the most capable (most expensive) model only at three moments: before the plan is final, when the same error shows up a second time, and before `done`.

These are prompt rules. Whether models follow them is not measured. The dispatcher does not hold wake-ups back: it still wakes the lead for each reply that arrives alone. Replies that are waiting together are batched (up to 5, `LEAD_BATCH_LIMIT` in `src/prompt.ts`), so the saving comes from fewer mails, not from the dispatcher delaying wake-ups.

### Choosing models per role

Models are set in your own `team.yaml` or `project.yaml`; the repo does not change your config. The aliases `opus`, `sonnet` and `haiku` are accepted and infer the `claude-code` runtime (`inferRuntime` in `src/schema.ts`). The Claude CLI resolves an alias to a concrete model, which depends on your provider and CLI version (on the Anthropic API `haiku` is Haiku 5.5, `claude-haiku-5-5`; see [Model aliases](https://code.claude.com/docs/en/model-config#model-aliases)); write the full model ID if you need a fixed one.

```yaml
# team.yaml (or agents: in project.yaml)
agents:
  tech-lead:      { runtime: claude-code, model: opus }
  cli-architect:  { runtime: claude-code, model: opus }
  node-engineer:  { runtime: claude-code, model: sonnet }
  code-explorer:  { runtime: claude-code, model: haiku }   # read-only search
```

A cheaper search model may miss things. Keep the role's reviewer when its answer drives a decision.

For Codex, keep reviewers on the other runtime (`codex`) and search and implementation on Claude. No cheap Codex model id is verified here, so leave Codex on its CLI default and use the existing [`fallback`](#fallback-models) chain unchanged.

### When you do not need the whole team

Cost is counted in wake-ups, and a team run is multi-agent from the start (in one user's run of 65 wake-ups the lead took 27). Solo mode already exists. Ask four questions about the task:

1. Do you need maker-checker review on the other runtime?
2. Can the work be split into independent, parallel parts?
3. Does it need different expertise?
4. Would a single agent run out of context?

If all four answers are "no", give the task to one member with `run --agent <name>` (see [run](commands.md#run), the `--agent` option); outside any project use [call](commands.md#call).

This is a rule of thumb adapted for this project. It is not copied from the "Graph Engineering" article's rule ("answer no to any question: keep a single loop"): the questions differ, and so does the rule (here solo only when all four are "no"). Its effect on cost and quality is not measured, so there is no guarantee and no saving percentage. In this project the first question is usually "yes", because cross-runtime review is deliberate.

### What max_rounds limits

`dispatcher.max_rounds` caps wake-up attempts, retries and fallback attempts included: `state.rounds` is incremented once per invoke attempt (`const round = ++state.rounds;` in `src/run-session.ts`) and checked before each attempt and before each batch. It can be used to bound how much work a run does.

It is not a token or money budget and guarantees no spending cap: the cost of a wake-up varies with the model, retries, output length and cache hits. The ~300k-token figure above is one user's measurement, not a benchmark.

- At the limit the run ends `partial` ("Stopped at the round limit before the lead sent done.", `src/run-outcome.ts`), and [`resume`](commands.md#resume) refuses until you raise the limit (`src/cli.ts`). After a reopen the limit counts from the reopen; see `resume` in the same page.
- The default is `0`, which means no limit (`src/schema.ts`; validated as an integer of at least 0).

### Not done

- `claude --advisor`: `claude --help` of the local claude 2.1.310 lists no such flag.
- "JEV": not found in the repo or the CLI, so it cannot be verified.

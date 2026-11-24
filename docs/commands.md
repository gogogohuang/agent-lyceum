# Commands

Full reference for every command. The [README](../README.md) has the short version. `agent-lyceum --help` shows a one-line summary per command; `agent-lyceum <command> --help` shows its full description and options.

## init

**Usage:** `init [-y]`

Create the home and a global agent library (`lead`, `fe-member`, `qa-member`). Asks before creating the default path.

## project add

**Usage:** `project add <name> --dir <repo>`

Register a project: creates `projects/<name>/project.yaml`, shared folders and `COMMON.md`.

## project and project remove

**Usage:** `project` / `project remove <name> [--purge]`

- `project` (no subcommand): list the registered projects.
- `project remove <name>`: unregister a project. Its context is kept unless you add `--purge`.

## run

**Usage:** `run ["task"] [--task-file f] [--name n] [--agent a] [--assume-defaults] [-p name]`

Give the task to the lead and run the dispatcher until done. If an agent asks you something the run pauses; see [Answering questions](#answering-questions).

Options:

- `"task"`: the task as text. Give this *or* `--task-file`, not both.
- `--task-file f`: read the task from a file. A [task file template](task-template.md) covers scope, acceptance criteria, out-of-scope, the verification command and whether it is a small change.
- `--name n`: name the run (default: made from the first line of the task). Lowercase letters, digits and `-`, at most 30 characters; refused if the name is already used. See "Continuing a finished run" in [How a run works](how-it-works.md#continuing-a-finished-run).
- `-p name`: the project (default: inferred from the current directory).
- `--assume-defaults`: when a question has a suggested value, use it instead of pausing. Questions without a suggestion still pause.
- `--agent a`: give the task to that one member of the project, and wake nobody else. See below. For small tasks this can cost far fewer wake-ups than the whole team; [When you do not need the whole team](configuration.md#when-you-do-not-need-the-whole-team) has four questions to decide, and notes that this project usually needs the cross-runtime review, so the team stays the default here.

With `--agent`:

- the member cannot mail teammates, cannot ask you and cannot edit any `AGENT.md`;
- its own `done` mail ends the run, so it must send one;
- it is an ordinary run otherwise: it has a run id and the project lock, shows in `status`, and can be resumed (the run remembers that it is solo) and cleared;
- `--assume-defaults` has no effect;
- a name that is not a member is refused with the member list; a name that only exists in the global library is pointed to [call](#call).

In a git repo with a commit the run (solo `--agent` runs too) starts from `HEAD` in its own worktree and ends with a branch to merge (`git merge <branch>` or `open_pr`); elsewhere it works directly in the folder, one agent at a time. See "Several runs at once" in [How a run works](how-it-works.md#several-runs-at-once).

If the lead's done asks for a pull request (`open_pr: true`) and the run completes on its own branch, the run opens it; see "Opening a pull request" in [How a run works](how-it-works.md#opening-a-pull-request).

## call

**Usage:** `call <agent> ["task"] [--task-file f] [--dir d] [-p project]`

Call one agent of the global library (`team.yaml`) on its own, **outside any project**: no `project.yaml` is read, no project lock is taken and nothing shows in `status`. The agent uses its global `AGENT.md` and its global memory. It may change files in the working directory and its own global memory; it cannot mail anyone or ask you.

Options:

- `"task"`: the task as text. Give this *or* `--task-file`.
- `--task-file f`: read the task from a file.
- `--dir d`: the directory the agent works in (default: the current directory). A directory inside or above the agent-lyceum home is refused, because a call lists only the called agent and could otherwise change other agents' files there.
- `-p project`: a registered project the agent may write **lesson and decision proposals** to (see [proposals](#proposals)). Without it a call reads and writes no project. With it, the call takes a non-exclusive lock on the project (runs and other calls carry on; `tidy` and `proposals review` wait for it) and sees the titles, not the bodies, of the project's records; it still cannot write the records. A project that does not exist is an error (exit code `1`).

Only the called agent's own `AGENT.md`, `COMMON.md` and the working directory's `CLAUDE.md`/`AGENTS.md` are checked: a change to one of them is put back and reported.

The agent's final reply is printed on stdout; everything else (progress, the call id) goes to stderr, so the answer can be piped. Each call keeps `task.md`, `log/` and `result.md` in `<home>/calls/<call-id>/` (nothing deletes them). Exit codes: `0` success, `1` failure or timeout (`dispatcher.wake_timeout_sec` default), `130` Ctrl-C. Only one call per agent can run at a time: a second one is refused while the first runs. A call cannot be resumed; call again.

If the agent has a `fallback` chain ([Fallback models](configuration.md#fallback-models)), a call falls back too, with the same kinds of failure as a run, but as a single shot: no retry on the same model, no wait, and its cooldowns end with the call. A failed call lists the models it tried in `result.md`.

With no `executors.yaml`, an empty `allow`, or an allow list that does not enroll this agent for `call`, the call keeps the behavior above: same invocation, prompts, policy, stderr, `result.md` and directory bytes, and no `requests/` tree.

When the agent is enrolled for `call`, each candidate is granted one writable directory, `requests/calls/<call-id>/proposals/`. The `requests/` root stays outside that grant, as do `ok.json`, `collected/`, `parked/` and any other agent's `proposals/`. The prompt says how to write a request file. The call does not feed an approval result back to the agent: the prompt carries no other request's status, denial or executor output, the call writes no `.feedback/`, and a later candidate does not receive a pending or denied result. `<call-id>` in the sentences below is this call's id (the id printed on stderr). Details of the marker and the locks are in [Call collection](approval-store-api.md#call-collection-stage-4-not-releasable). `approve` is not implemented; `list`, `show`, `audit` and `reject` are described below.

Before the runtime starts, `proposals/` must be a real empty directory. The same stop also happens when the fresh configuration or premises no longer pass: the fresh call view is not ok, including, once this call has a baseline, a qualification hash that differs from it. In either case the runtime stays stopped, the next candidate is not tried, and stderr is:

`Approval call not started: proposals could not be confirmed empty. Run agent-lyceum doctor; inspect requests/calls/<call-id>.`

Files already in that directory stay there. Nothing is collected and nothing is deleted. Run `agent-lyceum doctor`, repair the directory, and start a new call; this call has no resume. When the failure line can be written, it is appended to `<home>/calls/<call-id>/log.jsonl`.

A failed or cancelled candidate is moved to `requests/calls/<call-id>/parked/<n>` (`<n>` starts at 1 and increases across the fallback chain) when the park succeeds. Those files are never collected. When the park of a failed candidate fails, fallback stops and stderr is:

`Approval call stopped: failed-attempt proposals could not be parked. Inspect requests/calls/<call-id>.`

The failed candidate's files stay in place. They are not merged into the next candidate and they are not deleted. Repair the directory, then start a new call if the work is still wanted. The same log file receives the line when the append succeeds. When the park of a cancelled candidate fails, that line is not printed. The diagnostic is appended to the same log when the append works. If the append fails, stderr is `Approval call diagnostics could not be persisted.` The call then returns the cancelled result, and the files stay in place.

On a successful enrolled call the order is `guard.check`, then `requests/calls/<call-id>/ok.json`, then `<home>/calls/<call-id>/result.md`, then collection, then release of the call lease. A collection error leaves the success, the exit code and `result.md` as they are; the requests stay on disk for [approvals collect](#approvals-collect). A call whose collection was retained still exits 0, and the answer is on stdout; the retained notice is on stderr and in `<home>/calls/<call-id>/log.jsonl`, so a script must check stderr or run `approvals collect --call <call-id>`. When the marker cannot be published, the success text is not written, collection is not attempted, the command exits `1`, and stderr is:

`Approval call success marker could not be committed; no collection was attempted. Inspect requests/calls/<call-id>/ok.json.`

The runtime's request files stay in `proposals/`. They are not deleted. `approvals collect` applies after a valid `ok.json` exists. When `result.md` fails after `ok.json` is committed, the marker stays, the command exits `1`, and `approvals collect --call <call-id>` can collect the requests. That command does not rebuild the answer and does not rerun the call. A crash after `ok.json` is committed and before `result.md` is written is the same window: the requests can be collected, and there is no answer file. A crash before `ok.json` collects nothing. Pending requests are listed by [approvals list](#approvals-list). Recovery of the answer is a new call that you choose to run.

## approvals collect

**Usage:** `approvals collect --call <call-id>`

Finish collection for one call that already has `requests/calls/<call-id>/ok.json`. `<id>` in the messages is that same call id. `<CODE>` is a fixed gate code or a collection verdict code (configuration, premises, qualification hash, the collector budget, or the skipped verdict's code). `<role>` is the global agent name recorded on the marker. The command takes no positional argument, no run id and no `--json`. It does not require a terminal. It does not start a runtime, does not read `parked/`, and does not use `result.md` as the reason to collect. `approve` is not implemented; `list`, `show`, `audit` and `reject` are described below. This command does not open a list, and a list command is not required to retry it. The web console does not gain this command.

**No `ok.json`.** Exit `0`. Stdout is:

`Call <id>: no ok.json; nothing collected.`

The command creates no `requests/` directory, no `approvals/` directory, no `log.jsonl` and no lock. A failed call, a call whose `proposals/` is still nonempty, and a live call that never wrote `ok.json` all take this path. Their files stay where they are.

**With `ok.json`.** The command reads the marker (at most 1 MiB), takes the call lease for `<role>`, checks the marker again, rebuilds qualifications from the current global team and a fresh `executors.yaml`, and rechecks premises. It then finishes every `collected/<seq>` that has no `.done`, and rotates a nonempty `proposals/`. Stdout, including a second pass that finds nothing left to collect, is:

`Call <id>: approval collection complete.`

Exit `0`. A second successful pass leaves each persistent file's name, bytes, mode and mtime unchanged. A directory's mtime is outside that guarantee. The pass appends no log line and does not rewrite `.done`, the high-water file or `ok.json` when there is nothing left to do. `.lock-<role>` and `requests/calls/<id>/.coord` may exist during the pass. When the pass ends, both are absent. `.coord` exists only for that short pass. A live call is excluded first by the call lease, not by holding `.coord` for the whole call. When `<role>` is already in a call, the command exits `1` and stderr is `<role> is already being called (call <call-id>, pid <pid>). Wait for it to finish.` (`<pid>` is the recorded process id). The requests stay. Wait for that call to finish, then retry.

**Exit `1`.** Already written files stay, including `result.md` and any approval record already published. Nothing already collected is deleted. A failure line is appended to `<home>/calls/<id>/log.jsonl` when that append works. After the cause is fixed, run the same command again. A retry is available; finishing the command once does not mean a later pass will collect.

- Invalid or unsupported marker: stderr `Call <id>: invalid or unsupported requests/calls/<id>/ok.json; no collection attempted.` No new record is created. The marker and the request files stay. Publish a valid marker by a new successful call; this command does not rewrite `ok.json`.
- Configuration, premises, qualification hash, a removed role or executor, a `--dir` that is missing or now points elsewhere, or the collector budget: stderr `Call <id>: approval collection retained (<CODE>); fix configuration or run agent-lyceum doctor, then retry approvals collect --call <id>.` The requests stay in `proposals/` or in a `collected/<seq>` that has no `.done`. Fix the configuration or run `agent-lyceum doctor`, then retry. If `executors.yaml` was removed or changed, or the agent is no longer enrolled, recovery is to restore the configuration the call ran with, then run `approvals collect --call <call-id>`; the requests stay in place until then (`NOT_ALLOWED` when the agent is not enrolled, `SNAPSHOT_MISMATCH` when the qualification hashes differ). The diagnostic line is in `<home>/calls/<id>/log.jsonl`.
- Every directory anomaly (`DIR_ANOMALY`): a held or stale `.coord`, a symlinked or non-directory path, an unsupported filesystem, and a failed `coord`, `high_water`, `link_probe`, `rotate`, `park` or `list` operation. Stderr is `Call <call-id>: approval collection blocked (DIR_ANOMALY). See the approval_collect class in calls/<call-id>/log.jsonl; if it is held, stop all calls before removing a stale .coord.` Read the `class` of the `approval_collect` line in `<home>/calls/<call-id>/log.jsonl`. Per-class remedies are in [Operator actions](write-scope.md#operator-actions). Only when that `class` is `held`: stop all calls, confirm none is live, then remove the stale `.coord` directory by hand. The command does not remove it. The `held` row of that table is the run-slot remedy (stop runs); this command stops calls.
- When the log file itself cannot be written, stderr is `Approval call diagnostics could not be persisted.` The requests stay where the pass left them. Make `<home>/calls/<id>/` writable, then retry. On a call that already succeeded, this line does not change that success.

## approvals list

**Usage:** `approvals list [--all] [--json]`

Not releasable: step 0 unverified. Linux, a real terminal and the real sandbox are unverified. `approve`, the executor, `resolve`, gc and feedback are not implemented. None of these four commands starts an executor. Store rules are in [Read-only commands and lazy writes (stage 5a, not releasable)](approval-store-api.md#read-only-commands-and-lazy-writes-stage-5a-not-releasable).

`approvals list` shows only requests that are pending and not past their expiry. It writes nothing and starts no process.

`--all` lists every state. For a pending request past its expiry, or an executing request whose creator process is gone, it records `expired` or `unknown` and marks the row `[recorded now]`; when two commands race, exactly one records it. A failed lazy write adds `  [not recorded: <CODE>]` and is a problem (exit `1`); the other rows are still printed. A race that finds the state already written, or that loses 32 conflicts (`contended`), is not a problem: the row shows the state it found.

`--json` prints `{"schema_version":1,"requests":[...],"problems":[...]}`; it is independent of `status --json`. `schema_version` is printed only by `list --json`. On an error before listing (exit `1`), `--json` prints nothing on stdout; check the exit code before parsing. When the listing itself has a problem, stdout is still the full JSON and the exit code is `1`.

A row `corrupted (<CODE>)` or `unreadable (<CODE>)` is always listed, also without `--all`, and the command then exits `1`. A corrupt highest `state/<n>.json` (including a missing predecessor or an alias name such as `01.json`) refuses every transition. `show` and `list` mark that request `corrupted (<CODE>)`.

Without `executors.yaml` or `approvals/`, it prints `No pending approval requests.` and creates nothing. `--all` with no request and no problem prints `No approval requests.`

A request row is `<p>  <label>  <executor or ->  <proposer>  created <created_at>  expires <expires_at>`. `<p>` is the shortest unique prefix of at least 8 lowercase hex characters. When other readable committed requests are not pending, the last line (only when that count is greater than 0) is `<k> more request(s) not pending; approvals list --all shows every state.`

The id may be any unique prefix of at least 8 characters as printed by `approvals list`. These commands do not need `executors.yaml`; after removing it (rollback), use `approvals list` and `approvals reject` for requests still pending. The web console does not offer these commands.

When `approvals/` cannot be read, stderr is `Approvals store cannot be read (<CODE>): <path>.` Exit `1`. Nothing is written. The other shared id errors are under [approvals show](#approvals-show). Exit `0` when the listing has no problem.

## approvals show

**Usage:** `approvals show <id>`

`approvals show <id>` is read-only: it never records expiry or a dead creator; it shows the computed state, for example `expired (not yet recorded)`. An executing request whose creator process is gone is shown as `executing, creator dead (not yet recorded)`.

The screen has three zones: the agent statement, marked unverified; the executor name with `command[0]` real path and sha256; the complete payload. Every payload row starts with `│ `; a row that continues a wrapped or page-split line starts with `┆ `. Pages hold at most 4096 bytes of payload and are cut on character boundaries; all pages are printed in order. The payload is shown exactly as collected. If it or the summary fails the request allow-list it is withheld and the command exits `1`; do not approve such a request. The withheld marker is `(withheld: fails the request allow-list)`. `MISMATCH` means the payload changed after collection; the command exits `1`. The executor section needs `executors.yaml`; without it the executor shows `(not registered)` and the exit code is unchanged. A problem reading `executors.yaml` or inspecting `command[0]` does not change the exit code.

stderr, exit `1` (stdout still shows every readable part, except when `record.json` cannot be read, in which case stdout is empty):

- `Approval <id>: payload sha256 does not match record.json; the payload changed after collection.`
- `Approval <id>: payload cannot be read (<CODE>): <path>.`
- `Approval <id>: payload or summary fails the request allow-list and was not displayed; the record may have been altered.`
- `Approval <id>: state is corrupted (<CODE>): <path>. Every transition is refused.`
- `Approval <id>: record.json cannot be read (<CODE>): <path>. Every transition is refused.`

Shared id errors for `approvals show`, `approvals audit` and `approvals reject`. Exit `1`. Nothing is written:

- `Approval id "<arg>" is not valid: use 8 to 24 lowercase hex characters as printed by approvals list.`
- `No approval request matches "<arg>".`
- `Approval id prefix "<arg>" matches <k> requests; type more characters.`
- `Approvals store cannot be read (<CODE>): <path>.`

`<arg>` is the id you typed, with control characters removed and clipped to 64 characters. A normal show exits `0`. `show` probes a creator only when that request, or another request with the same payload, is `executing`. That probe may run `ps`. It does not write a file.

## approvals audit

**Usage:** `approvals audit <id>`

`approvals audit <id>` is read-only and prints the facts in `record.json` and every `state/<n>.json` event in sequence order, with the actor (user, terminal, pid, start time). Executor output, reasons and conclusions are shown with control characters removed and `\r` shown as `⏎`. Payload, summary and file names inside the request are not rewritten. A non-numeric name in `state/` (a temp file) is not listed.

The terminal is recorded by name when one can be found, otherwise as `rdev:<n>`, which is a device number only. The terminal check (stdin and stdout are terminals) is an aid, not a security boundary; terminal name lookup has not been verified on a real Linux or macOS terminal.

A missing or corrupt `state/<n>.json` is printed as `  #<n>  corrupted (<CODE>)  <path>`, and later numbers are still printed. `current:` is then `corrupted (<CODE>)`. stderr is `Approval <id>: state is corrupted (<CODE>): <path>. Every transition is refused.` Exit `1`. When `record.json` cannot be read, stdout is empty and stderr is `Approval <id>: record.json cannot be read (<CODE>): <path>. Every transition is refused.` Exit `1`. The shared id errors under [approvals show](#approvals-show) also apply. A normal audit exits `0`. `audit` probes a creator only for the `current:` line of an `executing` request.

## approvals reject

**Usage:** `approvals reject <id> [--reason <text>]`

`approvals reject <id> [--reason <text>]` needs a terminal on stdin and stdout, and an id prefix of 8 to 24 lowercase hex characters that matches exactly one request. Only a pending request can be rejected; a request past its expiry that is not yet recorded can still be rejected. `rejected` is final. `--reason` is one line of at most 300 visible characters. Omit `--reason` to record no reason. A clock earlier than `created_at` does not block `reject`.

The terminal is recorded by name when one can be found, otherwise as `rdev:<n>`, which is a device number only. The terminal check (stdin and stdout are terminals) is an aid, not a security boundary; terminal name lookup has not been verified on a real Linux or macOS terminal.

If two commands change the same request at once, exactly one succeeds; the other reports the state it found.

Checks stop at the first failure and, until the transition itself, write nothing: id syntax, then `--reason`, then the terminal, then the id prefix, then the actor, then the transition. The only successful write is `approvals/<id>/state/<n+1>.json` with `status: rejected`. On success, stdout is `Approval <id>: rejected.` Exit `0`.

stderr, exit `1`:

- `approvals reject needs an interactive terminal (stdin and stdout must be a TTY); nothing was changed.`
- `Approval <id>: not rejected; it is already <status>.`
- `Approval <id>: not rejected; only a pending request can be rejected (current: <status>).`
- `Approval <id>: not rejected; the state sequence cannot grow (SEQUENCE_OVERFLOW).`
- `Approval <id>: not rejected; the state kept changing. Run approvals show <id>, then retry.`
- `Approval <id>: not rejected; state is corrupted (<CODE>): <path>. Every transition is refused.` When the record is what failed, that sentence uses `record.json cannot be read (<CODE>): <path>.` in place of `state is corrupted (<CODE>): <path>.`
- `Approval <id>: not rejected; state cannot be written (<CODE>): <path>.`
- `--reason must not be empty; nothing was changed.`
- `--reason must be at most 300 characters; nothing was changed.`
- `--reason must be one line of visible text (no control, format or invisible characters); nothing was changed.`

The shared id errors under [approvals show](#approvals-show) also exit `1` and write nothing. `<status>` is the persisted state word (`pending`, `executing`, `unknown`, `executed`, `failed`, `rejected`, `expired`, `tampered`, or `denied`).

## resume

**Usage:** `resume [run] ["follow-up"] [--task-file f] [--answer [--no-edit]] [--assume-defaults] [-p name]`

Continue an interrupted or failed run, or reopen a finished one with a follow-up (each `run` is its own task; without a run, the newest run that is neither done nor running): same run dir, sessions and round count; the task is not re-sent and unread mail is picked up again. Refuses if the run is still alive. For a run that is already done it continues nothing: it prints the recorded outcome and result and exits with the code for that outcome (`0` completed, `2` partial/blocked, `1` failed; a run from before outcomes were recorded counts as an unverified `partial`, exit `2`). A run that ended idle or at `max_rounds` has no unread mail left unless you add some, so resuming it ends idle again (exit `2`). A run that is waiting for answers only continues once every open question has a valid answer; otherwise `resume` lists the missing ones and exits `3`.

Options:

- `run`: the run to continue: its full id, its name, or a unique prefix of either (default: the newest run that is neither done nor running). An ambiguous prefix lists the candidates and exits `1`; an empty one is refused.
- `"follow-up"` or `--task-file f`: reopen a finished (`done`) run with a follow-up request. The lead gets it as a new `task` and the run goes on with its task memory and worktree; see below. Give the text or `--task-file`, not both. After the reopen, every agent's prompt carries the index of the lead's handoff notes (`task-memory/<run-id>/_shared/MEMORY.md`).
- `-p name`: the project.
- `--answer`: first answer the questions the run is waiting on; see [Answering questions](#answering-questions).
- `--no-edit`: with `--answer`, do not open the editor.
- `--assume-defaults`: use the suggested answer for every open question that has one.

**Reopening a finished run.** With follow-up text, only a finished (`done`) run is reopened: a run that is still running is refused, and a run that is not finished is refused too (resume it without text first). Without text a finished run only prints its result, as before.

- Without a run, the candidates are the finished runs, newest first: exactly one is used, none is an error, and several are listed (in a terminal a numbered picker takes a number or a name; without a terminal the command fails and lists them).
- A lone argument is follow-up text only when it cannot be a run reference (it contains whitespace or a character a run name cannot contain); otherwise an unknown lone argument is "run not found". A one-word follow-up needs `resume <run> "<text>"` or `--task-file`.
- The follow-up is saved as `runs/<run-id>/followups/<n>.md`; each `done` report is kept as `done-<n>.md` and `result.md` is the latest. The round limit counts from the reopen (`rounds` keeps accumulating; the limit is the rounds at reopen plus `max_rounds`). Each reopened segment gets fresh done-contract reminders; unresolved blocked integrations are kept.
- With a lead worktree: if the lead branch was already merged into your `HEAD` and the worktree is clean and untouched since the run ended, the worktree and branch (same name) are re-cut from the current `HEAD` and a line says so; otherwise the same ones continue. With a recorded pull request and no re-cut, a new `open_pr: true` only pushes ("pull request updated") while that pull request is still open (if it was merged, a squash merge included, or closed, a new one is opened); after a re-cut the recorded `pr_url` is cleared (kept in the run's notes) and a new pull request is opened when asked. agent-lyceum never merges.

See "Continuing a finished run" in [How a run works](how-it-works.md#continuing-a-finished-run).

## Answering questions

**Usage:** `resume <run-id> --answer [--no-edit] [--assume-defaults] [-p name]`

Answer the questions a waiting run asked. An agent asks with a `type: ask` mail (the lead always may; a member needs `can_ask_user: true`). The dispatcher stores all questions in one file, `runs/<run-id>/mail/ask-reply.md`, ends the run as `waiting` (exit `3`, lock released, no round used) and prints the file's path; `status` shows it too, with the number of open questions.

```xml
<ask-reply status="pending" asked_by="lead" round="7">
  <question id="q1" asker="lead">
    <text>Session or JWT for login?</text>
    <options>
      <option>session</option>
      <option>jwt</option>
    </options>
    <suggested reason="existing code already uses cookies">session</suggested>
    <answer></answer>
  </question>
</ask-reply>
```

You only fill in the `<answer>` tags:

- a question with `<options>`: pick one by its letter or number (`a`, `2`) or write it out, or type any text of your own (`other:` is optional). A short reply such as `local` is fine: answers are never limited to the options. Agents must write each option as its full content; an option that is only a label (`A`, `b)`) is rejected when the agent asks;
- a question without options: write any non-empty text.

Options:

- `--answer`: open the file in `$VISUAL`/`$EDITOR` (default `vi`) and check the answers. Once they are all valid, they are sent to the agent that asked (as a `reply` mail with an `<answers>` block) and the run continues.
- `--no-edit`: skip the editor and only check a file you already edited. Editing the file by hand and running `resume` does the same.
- `--assume-defaults`: fill every unanswered question that has a `<suggested>` value (marked `by="default"` in the file); the others keep waiting.

Also:

- if something is missing or invalid, the problems are listed and the exit code is `3`;
- in a terminal, `run` and `resume` open the editor by themselves when a run starts waiting;
- questions you already answered stay in the file and are not asked again when the agent asks a second batch.

## status

**Usage:** `status [-p name] [--monitor]`

Shows the agents, unread mail, what is running right now (agent, elapsed time, message being handled) and the last run (task source, rounds, end reason, output tokens).

Options:

- (none): also prints the full wake-by-wake record of the latest run.
- `-p name`: the project.
- `--monitor`: keep a live page open, showing only the latest three wakes of each run.
- `--task-id id`: print everything about one task (every wake, its result, log directory). `id` is a full run id, a name or a unique prefix of either.
- `--task-list [project]`: list every run of the project with its id, state, rounds and task (feed the id to `resume`).
- `--json`: print the same report as JSON (`schema_version: 1`, no colour, nothing else on stdout; errors go to stderr with a non-zero exit). It works with `--task-list` and `--task-id`. Text and JSON are made from the same report.
- `--web`: open a local browser page for every registered project (default `127.0.0.1:8787`). The page shows a wake timeline, one block per agent with what it is doing, tokens and cache, plus agents, steps, the queue and fallback. It also asks Claude and Codex, with each runtime's own command, how much of the account usage limit is left, and refreshes that about once a minute. When any registered project has an agent or fallback on `cursor`, it asks Cursor too: unlike `doctor`, this reads your Cursor login (the CLI's `auth.json` in `CURSOR_CONFIG_DIR` or `~/.cursor`, the macOS keychain entry `cursor-access-token`, `CURSOR_API_KEY`, then the Cursor IDE's `state.vscdb`) and sends it only to Cursor's own API (`api2.cursor.sh`; `CURSOR_API_ENDPOINT` is honoured only for another `https://*.cursor.sh` host). A token the API refuses is skipped for the next one. A button on the page asks again immediately. Summarize progress, beside the task title, asks that project's lead runtime to write the task on screen as a short account; pressing it again writes a new one, and nothing is saved. Finished tasks stay listed. `--port` (0 picks a free port), `--host`, `--no-open`, `--allow-host` and `--exit-with-parent` apply only with this option. **Breaking:** the server now rejects requests whose `Host` header is not `127.0.0.1`, `localhost`, `::1` or the `--host` value (HTTP 403; a missing or malformed `Host` is 400), and `POST /quota` rejects a cross-site `Origin`; this stops DNS rebinding. If you reach the page through another name (for example `mybox.local` in `/etc/hosts`), pass `--allow-host mybox.local` (repeatable). The Host and `POST /quota` checks are skipped when `--host` is not a loopback address. `--exit-with-parent` makes the server exit when its parent process goes away or its stdout is closed; the status-monitor mod uses it. `GET /health` returns `{ app: "agent-lyceum-web", version, pid, ppid, home, started_at }`. If the port is already taken, the process prints one line to stderr saying who holds it (`status --web: port N in use by agent-lyceum-web pid P home H`, `... by another program`, or `... no answer in 1 s`) and exits 1. `--heartbeat` is how often the project list is scanned again, default 5 seconds. It cannot be combined with `--json`, `--watch`, `--monitor`, `--task-list`, `--task-id` or `-p`. Build the page first: `pnpm --dir web install && pnpm --dir web build`. The page can also run every other command; see [Web console](web-console.md). **Restriction:** with `--host` set to a non-loopback address, all of `/api/*` (reads and writes) is refused with HTTP 403 and cannot be enabled; the read-only status page still works.
- For an agent with a `fallback` chain, `--json` also carries `runtime` (the runtime of its latest wake, so it can differ from the configured one), `model`, `fallback` (`{ "from": "<runtime>/<model>", "kind": "rate_limit" }`, only while it runs on a backup) and `cooldowns` (`[{ "model", "kind", "remaining_sec" }]`, the models of its chain that are cooling down; `model` is the raw key, `claude-code/` for a runtime's default model). Agents without a chain have none of these fields. The text report adds a line per agent on a backup and per cooldown. Additive; `schema_version` stays `1`.
- `--json` also carries, per agent, `can_message` (who it may send mail to; `all` expanded, itself left out), and, for every message in `run.active[*].handling`, `run.queue[*]` and `run.wakes[*].handling`, a `digest`: short sections by message type (`[{ "label": "目標", "lines": ["…"] }]`). Both are additive; `schema_version` stays `1`.

## clear

**Usage:** `clear <run> [-p name] [--dry-run] [--keep-worktrees]` · `clear --lock [run-id] [-p name] --force`

Delete a task (run) by id, name or unique prefix (an ambiguous prefix lists the candidates and exits `1`): its run directory (state, log, result, kept copies of reverted protected-file edits, mailboxes), its **task memory** (the handoff notes included), and its agents' git worktrees, branches and snapshot refs. Global and project (long-term) memory is never touched. A run that was interrupted (its process is gone, it never ended) is cleared directly, without `clear --lock --force` first; `clear` replaces and removes the stale run lock itself. It refuses, and deletes nothing, while the run's process is still running (a live process holds its lock) or while a worktree holds work that is not in your repo (uncommitted, or committed but not brought in); it lists that work. Symlinks are never followed out of the project home. Progress is journaled in `projects/<name>/cleanup/`, so an interrupted `clear` is finished by repeating the same command. List ids with `status --task-list`.

Options:

- `-p name`: the project.
- `--dry-run`: only print what would be deleted and kept.
- `--keep-worktrees`: keep the worktrees and their branches, and still clear the rest.

**`clear --lock`** removes the run lock a crashed run left behind. Each active run holds its own lock. Without `--force` it only shows who holds the lock. Without a run id it acts on the only lock; when several runs hold one it lists them and asks you to name the run. A lock file that cannot be read is cleared too.

With `--force`:

- the lock is removed even though its owner cannot be confirmed dead.

**Upgrading from an older version:** on Linux a lock records the holder's start time as `proc:<ticks>` (read from `/proc`), where older versions wrote the `ps` text. The two cannot be compared, so a lock written by an older version is judged by its pid alone: if that pid has since been reused by an unrelated process, the stale lock is not reclaimed automatically and you need `clear --lock --force`. An older version's project-wide `lock.json` is still honoured: while its process is alive it counts as one active run.

A concurrent run's lead branch counts as work that is not in the repo until it is merged into `HEAD`.

## doctor

**Usage:** `doctor [-p name] [--task-file f] [--json]` · `doctor --resolved [-p name] [--json]`

Check the setup without running any agent:

- configuration (each agent's enforcement level is printed; the `handoff` column is the protection of the run's handoff notes, `n/a` for the lead because it may write them);
- git (for parallel runs);
- whether `gh` and `origin` are available for opening a pull request (when the repo is a git repository with a commit);
- the project lock;
- the CLI of every runtime used only by a `fallback` chain: whether it is installed. A missing one is a warning, not an error, and does not stop a run (a run checks the primaries only). Login is not checked;
- what each runtime CLI supports, read from its `--version` and `--help` (JSON output, resume, sandbox settings, effort; each is `yes`, `no` or `unknown`).

Options:

- `-p name`: the project.
- `--task-file f`: also check a task file.
- `--resolved`: print the effective settings instead; see below.
- `--json`: print the report as JSON.

Exit 1 on configuration errors or when something the team needs is explicitly unsupported. It does not read credentials: login status is reported as unknown. `run` and `resume` do the same capability check first: they refuse to start on an explicit `no` and warn on `unknown`. A real end-to-end check against the live CLIs (a tiny task) spends tokens and is deliberately manual.

The last line of the text output summarises the checks: no errors and no warnings prints "No problems found."; warnings only says there are no errors and how many warnings to review; any error prints "Problems found:" with the error count, plus the warning count only when there are warnings. `info` and `ok` lines never count. Warnings alone do not change the exit code (still `0`), and `--json` output is unchanged.

**`doctor --resolved`** runs no check and prints every effective setting (global library, project file and defaults merged) and where it came from: the file and key, `default`, or `inferred from <model key>` when the runtime was recognised from `model`. Project values replace global ones; lists (`can_message`) are replaced, not merged; relative paths are resolved against the file they were written in.

Example: with `model_tiers: { claude-code: [haiku, sonnet, opus] }` in `team.yaml` and `fe-member` set to `model: opus`, `agent-lyceum doctor --resolved -p demo` includes these rows (excerpt of real output; the other rows are omitted):

```
model_tiers.claude-code = ["haiku","sonnet","opus"]                                 team.yaml
agents.fe-member.model = opus                                                       team.yaml
agents.fe-member.model_tiers = ["haiku","sonnet","opus"]                            team.yaml
```

## demo

**Usage:** `demo [--dir path] [--runtime claude-code|codex] [--setup-only] [-y]`

Try agent-lyceum without setting anything up. It builds a throwaway sandbox (a tiny git repo whose `npm test` fails because `slugify()` is not written, plus its own agent-lyceum home with a registered project), then runs the real `run` on it: the lead hands the work to `fe-member`, and `qa-member` checks it. Your own home, projects and repos are never touched.

It makes real `claude` / `codex` calls, so it spends a little of your quota (a few minutes). It asks before starting unless you pass `-y`.

Options:

- `--dir path`: the sandbox directory, which must be new or empty (default: a new folder in the system temp dir).
- `--runtime r`: `claude-code` or `codex` for all three agents (default: whichever CLI is on your PATH, `claude` first).
- `--setup-only`: build the sandbox, write `task.md` and print the commands, but run no agents.
- `-y`: do not ask before running real agents.

When it ends it prints how to look around (`status`, `git log --stat` in the sandbox repo) and how to delete the sandbox. The exit code is the one `run` returned, see [Exit codes](#exit-codes).

## tidy

**Usage:** `tidy [-p name] [--agent a] [--layer project|global] [--dry-run]` · `tidy --undo <timestamp> -p name --agent a [--layer project|global]`

Have agents tidy their own long-term memory: merge entries that say the same thing, rewrite stale ones, and retire what is obsolete. **It only ever runs when you run it**: a run ending, a large memory or changes in the repo never start a tidy; `status` and `doctor` at most suggest one.

Options:

- `-p name`: the project.
- `--agent a`: tidy only this agent (default: every agent).
- `--layer project`: the default; tidy the **project** memory of the agent(s).
- `--layer global`: tidy **global** memory. It is shared by every project, so it is only tidied when you ask.
- `--dry-run`: only print the memory sizes, the project changes and the missing paths. It wakes nobody, changes nothing and takes no lock.
- `--undo timestamp`: tidy nothing; undo the tidy with that timestamp instead. See below.

Task memory is never tidied (`clear` deletes it). Note that the project template gives agents global memory only: to use project memory, set `memory.project` for an agent in `project.yaml`. With no such agent and no project records in scope, the command says so and exits `0`.

Each agent is woken once for this, outside any run (no round is used), and may change only its own memory dir, and the lead's wake also the project records; during a tidy the runtime can only write those directories (no repo, mail or shared files). Retiring is archiving, never deleting: files go to `memory/.archive/<timestamp>/` under the same relative path, together with a `tidy-report.md` (what was merged, what was archived and why, what is still doubtful). The agent is shown the size and age of every memory file, the `MEMORY.md` index, what changed in the project repo (`git log` and `git diff --stat`) since the last tidy, and the paths its memory mentions that no longer exist. `memory/.tidy-state.json` remembers the repo `HEAD` of the last tidy; the first tidy has no baseline and only does the path check.

agent-lyceum checks the result: every file that existed before must still be in place or under this tidy's archive folder, `tidy-report.md` must exist, and the agent's other memory directories must be unchanged. If the wake-up fails or times out, or any check fails, the memory directory is put back exactly as it was, the baseline is not updated and the exit code is `1`. The command needs the project to itself: `tidy` (and `tidy --undo`) is refused while any run is active, and no run can start while it runs.

**Project records:** with `--layer project` (the default) the lead's wake-up also tidies the project records (`shared/common/records/`), even if the lead has no memory dir; `--agent <lead>` includes them, `--agent <other>` and `--layer global` do not. Merged or obsolete entries move to `records/.archive/<timestamp>/` with a `tidy-report.md`; nothing is deleted. Any violation rolls back both the memory dir and the records, and the exit code is `1`. `--dry-run` also prints a records line (files, size, active entries per kind). `doctor` and `status` hint when a kind is over its 12 KB budget; `doctor` also warns about invalid frontmatter and unknown `supersedes` ids.

**Proposals:** the lead's wake-up also archives decided proposals (see [proposals](#proposals)) to `proposals/.archive/<timestamp>/`, even in a project that has only proposals; a proposal that is still `proposed`, or decided less than 30 days ago, is never archived, and a tidy that edits a proposal is rolled back.

**`tidy --undo <timestamp>`** undoes one tidy: it moves the files of `memory/.archive/<timestamp>/` back to where they were and adds them to `MEMORY.md` if the index does not mention them. With `--agent <lead>` it also restores the records archive of that timestamp. `tidy` prints the timestamp, and the exact undo command, when it finishes.

- `--agent a`: whose memory to restore. Required.
- `--layer project|global`: which memory layer (default `project`).
- `--dry-run` cannot be combined with `--undo`.
- A file whose name exists now is not overwritten; it is reported and stays in the archive.

## proposals

**Usage:** `proposals list [-p name]` · `proposals review [-p name]`

An agent that runs alone (`run --agent`, or `call -p`) is not part of a team, so what it learns has no way into the project records, which only the lead may write. It can write a **proposal** instead: one Markdown file in `proposals/lessons/` or `proposals/decisions/` (next to `shared/` in the project folder, not under `records/`), with `status: proposed`, the facts it observed, its guess at the cause and at least one `evidence` entry (a file path with line and commit, a commit, a mail, or a command with its key output). The file name starts with a short id of its run, which the prompt gives it as a literal. It can only create and change its own `proposed` files: anything else it writes there, and anything it writes to the records, is put back and reported.

Only the lead decides a proposal: it accepts it by creating a **new** record and setting `status: accepted` with `accepted_as: <kind>/<id>` and `decided: <date>`, or rejects it with `reject_reason` and `decided`. In a normal run the lead is shown the pending proposals (at most 10, oldest first, with how well the evidence checks out) and its `done` is refused while an accepted or rejected proposal is incomplete. Pending proposals never block `done`.

- `proposals list`: show how many wait, the oldest date, the evidence and every incomplete decision. Changes nothing. `status` and `doctor` also mention what waits.
- `proposals review`: for a project with no normal run (only `run --agent` or `call -p`), wake the lead once to decide the pending ones and write the records. It needs the project to itself (refused while a run or a `call -p` is active); the lead may write only the records and the proposals; and the whole review is undone if a decision is incomplete, a record or proposal is deleted, an already decided proposal changes, a records kind goes over 12 KB or the report `proposals/.reviews/<timestamp>.md` is missing. `proposals review` and `proposals list` never write a proposal or a record themselves, and there is no command that accepts or rejects for you.

`tidy` archives a decided proposal to `proposals/.archive/<timestamp>/` once its `decided` date is more than 30 days old; `tidy --undo` brings it back.

## Stopping a run

**Stopping a run:** Ctrl-C (or SIGTERM) cancels it cleanly: running agents get SIGTERM, then SIGKILL after 5 s (their whole process tree), unread mail is kept, the lock is released and the exit code is `130`; continue later with `agent-lyceum resume`. A second Ctrl-C quits at once. `npx`, `npm exec`/`npm run` and `tsx` do not pass SIGHUP on: if such a launcher exits (for example, the terminal is closed), `run`, `resume` and `call` are cancelled the same way (exit `130`), while `tidy` restores its snapshot and exits `1`. To keep a run going after its launcher exits, run the installed `agent-lyceum` binary directly; inside an npm script, which inherits `npm_execpath`, use `env -u npm_execpath agent-lyceum …`. A wake-up that exceeds `wake_timeout_sec` is stopped the same way as Ctrl-C and counts as a failed attempt. Each attempt's complete stdout/stderr is written to `runs/<run-id>/mail/attempts/<attempt>/log/`; only the last 64 KiB of each stream is kept in memory.

## Exit codes

**Exit codes of `run` / `resume`:** `0` only when the lead reported `outcome: completed`; `2` for `partial` or `blocked` (also when the run went idle or hit `max_rounds`, if you set one, without a done); `1` for `failed` (also when the lead or another agent kept failing and the run stopped: continue with `resume` after fixing the cause); `3` when the run is waiting for your answers (see [Answering questions](#answering-questions)); `130` for `cancelled`. *Upgrading:* before this version an `idle` run exited `0` and a failed lead exited `2`; scripts that treated `0` as "the run ended" must now check for `0` as "the work was completed". Runs that ended before outcomes were recorded show as unverified (`partial`) and are not reported as a success. For the exit codes of `call` (`0`, `1`, `130`), see [call](#call). `approvals collect` exits `0` or `1`; see [approvals collect](#approvals-collect). `approvals list`, `show`, `audit` and `reject` exit `0` or `1`.

## Choosing the project

Without `--project`, the project is the registered one whose `dir` is the longest prefix of the current directory; if none matches the command lists the registered projects and stops.

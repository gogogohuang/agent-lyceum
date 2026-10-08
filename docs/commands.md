# Commands

Full reference for every command. The [README](../README.md) has the short version.

## init

**Usage:** `init [-y]`

Create the home and a global agent library (`lead`, `fe-member`, `qa-member`). Asks before creating the default path.

## project add

**Usage:** `project add <name> --dir <repo>`

Register a project: creates `projects/<name>/project.yaml`, shared folders and `COMMON.md`.

## project list and remove

**Usage:** `project list` / `project remove <name> [--purge]`

List projects / unregister (keeps context unless `--purge`).

## validate

**Usage:** `validate [-p name] [--task-file f]`

Validate the merged config and print each agent's enforcement level. Exit 1 on errors.

## run

**Usage:** `run ["task"] [--task-file f] [--agent a] [--assume-defaults] [-p name]`

Give the task to the lead and run the dispatcher until done. Give *either* text or `--task-file`. If an agent asks you something the run pauses; see [answer](#answer). `--assume-defaults` answers every question that has a suggested value with it instead of pausing (questions without a suggestion still pause).

With `--agent <name>` the task goes to that one member of the project and nobody else is woken: it cannot mail teammates, cannot ask you and cannot edit any `AGENT.md`, and its own `done` mail ends the run (so it must send one). It is an ordinary run otherwise: it has a run id and the project lock, shows in `status`, and can be resumed (the run remembers that it is solo) and cleared. `--assume-defaults` has no effect with it. A name that is not a member is refused with the member list; a name that only exists in the global library is pointed to [call](#call).

## call

**Usage:** `call <agent> ["task"] [--task-file f] [--dir d]`

Call one agent of the global library (`team.yaml`) on its own, **outside any project**: no `project.yaml` is read, no project lock is taken and nothing shows in `status`. The agent works in `--dir` (default: the current directory), with its global `AGENT.md` and its global memory. It may change files in that directory and its own global memory; it cannot mail anyone, ask you, or edit any `AGENT.md`, `COMMON.md` or configuration (a change to a protected file is put back and reported). Give the task as text *or* `--task-file`.

The agent's final reply is printed on stdout; everything else (progress, the call id) goes to stderr, so the answer can be piped. Each call keeps `task.md`, `log/` and `result.md` in `<home>/calls/<call-id>/` (nothing deletes them). Exit codes: `0` success, `1` failure or timeout (`dispatcher.wake_timeout_sec` default), `130` Ctrl-C. Only one call per agent can run at a time: a second one is refused while the first runs. A call cannot be resumed; call again.

## resume

**Usage:** `resume [run-id] [--assume-defaults] [-p name]`

Continue an interrupted or failed run (each `run` is its own task; without an id, the newest run that is neither done nor running): same run dir, sessions and round count; the task is not re-sent and unread mail is picked up again. Refuses if the run is still alive. For a run that is already done it continues nothing: it prints the recorded outcome and result and exits with the code for that outcome (`0` completed, `2` partial/blocked, `1` failed; a run from before outcomes were recorded counts as an unverified `partial`, exit `2`). A run that ended idle or at `max_rounds` has no unread mail left unless you add some, so resuming it ends idle again (exit `2`). A run that is waiting for answers only continues once every open question has a valid answer; otherwise `resume` lists the missing ones and exits `3`.

## answer

**Usage:** `answer <run-id> [--no-edit] [--assume-defaults] [-p name]`

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

You only fill in the `<answer>` tags. For a question with `<options>` write one of them, or start with `other:` and write your own text; a question without options takes any non-empty text. `answer` opens the file in `$VISUAL`/`$EDITOR` (default `vi`), checks the answers, and, once they are all valid, sends them to the agent that asked (as a `reply` mail with an `<answers>` block) and continues the run. `--no-edit` skips the editor and only checks a file you already edited; editing the file by hand and running `resume` does the same. If something is missing or invalid, the problems are listed and the exit code is `3`. In a terminal, `run` and `resume` open the editor by themselves when a run starts waiting. `--assume-defaults` fills every unanswered question that has a `<suggested>` value (marked `by="default"` in the file); the others keep waiting. Questions you already answered stay in the file and are not asked again when the agent asks a second batch.

## status

**Usage:** `status [-p name] [--monitor]`

Agents, unread mail, what is running right now (agent, elapsed time, message being handled), last run (task source, rounds, end reason, output tokens). Without `--monitor` it also prints the full wake-by-wake record of the latest run; `--monitor` keeps a live page open showing only the latest three wakes of each run. `--task-id <id>` prints everything about one task (every wake, its result, log directory). `--task-list [project]` lists every run of the project with its id, state, rounds and task (feed the id to `resume`). `--json` prints the same report as JSON (`schema_version: 1`, no colour, nothing else on stdout; errors go to stderr with a non-zero exit); it works with `--task-list` and `--task-id`. Text and JSON are made from the same report.

## clear

**Usage:** `clear <run-id> [-p name] [--dry-run] [--keep-worktrees]`

Delete a task (run) by id: its run directory (state, log, result, kept copies of reverted protected-file edits, mailboxes), its **task memory**, and its agents' git worktrees, branches and snapshot refs. Global and project (long-term) memory is never touched. It refuses, and deletes nothing, while the run is still running or while a worktree holds work that is not in your repo (uncommitted, or committed but not brought in); it lists that work. `--keep-worktrees` keeps the worktrees and their branches and still clears the rest. `--dry-run` only prints what would be deleted and kept. Symlinks are never followed out of the project home. Progress is journaled in `projects/<name>/cleanup/`, so an interrupted `clear` is finished by repeating the same command. List ids with `status --task-list`.

## config show

**Usage:** `config show --resolved [-p name] [--json]`

Print every effective setting (global library, project file and defaults merged) and where it came from: the file and key, `default`, or `inferred from <model key>` when the runtime was recognised from `model`. Project values replace global ones; lists (`can_message`, `owns`) are replaced, not merged; relative paths are resolved against the file they were written in.

## doctor

**Usage:** `doctor [-p name] [--json]`

Check the setup without running any agent: configuration, git (for parallel runs), the project lock, and what each runtime CLI supports, read from its `--version` and `--help` (JSON output, resume, sandbox settings, effort; each is `yes`, `no` or `unknown`). Exit 1 when something the team needs is explicitly unsupported. It does not read credentials: login status is reported as unknown. `run` and `resume` do the same capability check first: they refuse to start on an explicit `no` and warn on `unknown`. A real end-to-end check against the live CLIs (a tiny task) spends tokens and is deliberately manual.

## memory tidy

**Usage:** `memory tidy [-p name] [--agent a] [--layer project|global] [--dry-run]`

Have agents tidy their own long-term memory: merge entries that say the same thing, rewrite stale ones, and retire what is obsolete. **It only ever runs when you run it**: a run ending, a large memory or changes in the repo never start a tidy; `status` and `doctor` at most suggest one.

By default it tidies the **project** memory of every agent. **Global** memory is shared by every project, so it is only tidied with `--layer global`; task memory is never tidied (`clear` deletes it). Note that the project template gives agents global memory only: to use project memory, set `memory.project` for an agent in `project.yaml`. With no such agent the command says so and exits `0`.

Each agent is woken once for this, outside any run (no round is used), and may only change its own memory. Retiring is archiving, never deleting: files go to `memory/.archive/<timestamp>/` under the same relative path, together with a `tidy-report.md` (what was merged, what was archived and why, what is still doubtful). The agent is shown the size and age of every memory file, the `MEMORY.md` index, what changed in the project repo (`git log` and `git diff --stat`) since the last tidy, and the paths its memory mentions that no longer exist. `memory/.tidy-state.json` remembers the repo `HEAD` of the last tidy; the first tidy has no baseline and only does the path check.

agent-lyceum checks the result: every file that existed before must still be in place or under this tidy's archive folder, `tidy-report.md` must exist, and the agent's other memory directories must be unchanged. If the wake-up fails or times out, or any check fails, the memory directory is put back exactly as it was, the baseline is not updated and the exit code is `1`. The command needs the project lock, so it refuses while a run is active. `--dry-run` only prints the memory sizes, the project changes and the missing paths: it wakes nobody, changes nothing and takes no lock.

## memory restore

**Usage:** `memory restore <timestamp> -p name --agent a [--layer project|global]`

Undo a tidy: move the files of `memory/.archive/<timestamp>/` back to where they were and add them to `MEMORY.md` if the index does not mention them. A file whose name exists now is not overwritten; it is reported and stays in the archive. `tidy` prints the timestamp when it finishes.

## unlock

**Usage:** `unlock [-p name] --force`

Remove the project's run lock left behind by a crashed run (only one run per project at a time). Without `--force` it only shows who holds the lock.

**Upgrading from an older version:** on Linux a lock records the holder's start time as `proc:<ticks>` (read from `/proc`), where older versions wrote the `ps` text. The two cannot be compared, so a lock written by an older version is judged by its pid alone: if that pid has since been reused by an unrelated process, the stale lock is not reclaimed automatically and you need `unlock --force`.

## Stopping a run

**Stopping a run:** Ctrl-C (or SIGTERM) cancels it cleanly: running agents get SIGTERM, then SIGKILL after 5 s (their whole process tree), unread mail is kept, the lock is released and the exit code is `130`; continue later with `agent-lyceum resume`. A second Ctrl-C quits at once. A wake-up that exceeds `wake_timeout_sec` is stopped the same way and counts as a failed attempt. Each attempt's complete stdout/stderr is written to `runs/<run-id>/mail/attempts/<attempt>/log/`; only the last 64 KiB of each stream is kept in memory.

## Exit codes

**Exit codes of `run` / `resume`:** `0` only when the lead reported `outcome: completed`; `2` for `partial` or `blocked` (also when the run went idle or hit `max_rounds` without a done); `1` for `failed` (also when the lead itself failed); `3` when the run is waiting for your answers (see [answer](#answer)); `130` for `cancelled`. *Upgrading:* before this version an `idle` run exited `0` and a failed lead exited `2`; scripts that treated `0` as "the run ended" must now check for `0` as "the work was completed". Runs that ended before outcomes were recorded show as unverified (`partial`) and are not reported as a success.

## Choosing the project

Without `--project`, the project is the registered one whose `dir` is the longest prefix of the current directory; if none matches the command lists the registered projects and stops.

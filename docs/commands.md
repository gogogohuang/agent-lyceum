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

**Usage:** `run ["task"] [--task-file f] [-p name]`

Give the task to the lead and run the dispatcher until done. Give *either* text or `--task-file`.

## resume

**Usage:** `resume [run-id] [-p name]`

Continue an interrupted or failed run (each `run` is its own task; without an id, the newest run that is neither done nor running): same run dir, sessions and round count; the task is not re-sent and unread mail is picked up again. Refuses if the run is still alive. For a run that is already done it continues nothing: it prints the recorded outcome and result and exits with the code for that outcome (`0` completed, `2` partial/blocked, `1` failed; a run from before outcomes were recorded counts as an unverified `partial`, exit `2`). A run that ended idle or at `max_rounds` has no unread mail left unless you add some, so resuming it ends idle again (exit `2`).

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

## unlock

**Usage:** `unlock [-p name] --force`

Remove the project's run lock left behind by a crashed run (only one run per project at a time). Without `--force` it only shows who holds the lock.

## Stopping a run

**Stopping a run:** Ctrl-C (or SIGTERM) cancels it cleanly: running agents get SIGTERM, then SIGKILL after 5 s (their whole process tree), unread mail is kept, the lock is released and the exit code is `130`; continue later with `agent-lyceum resume`. A second Ctrl-C quits at once. A wake-up that exceeds `wake_timeout_sec` is stopped the same way and counts as a failed attempt. Each attempt's complete stdout/stderr is written to `runs/<run-id>/mail/attempts/<attempt>/log/`; only the last 64 KiB of each stream is kept in memory.

## Exit codes

**Exit codes of `run` / `resume`:** `0` only when the lead reported `outcome: completed`; `2` for `partial` or `blocked` (also when the run went idle or hit `max_rounds` without a done); `1` for `failed` (also when the lead itself failed); `130` for `cancelled`. *Upgrading:* before this version an `idle` run exited `0` and a failed lead exited `2`; scripts that treated `0` as "the run ended" must now check for `0` as "the work was completed". Runs that ended before outcomes were recorded show as unverified (`partial`) and are not reported as a success.

## Choosing the project

Without `--project`, the project is the registered one whose `dir` is the longest prefix of the current directory; if none matches the command lists the registered projects and stops.

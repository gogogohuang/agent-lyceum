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
- `--task-file f`: read the task from a file.
- `--name n`: name the run (default: made from the first line of the task). Lowercase letters, digits and `-`, at most 30 characters; refused if the name is already used. See "Continuing a finished run" in [How a run works](how-it-works.md#continuing-a-finished-run).
- `-p name`: the project (default: inferred from the current directory).
- `--assume-defaults`: when a question has a suggested value, use it instead of pausing. Questions without a suggestion still pause.
- `--agent a`: give the task to that one member of the project, and wake nobody else. See below.

With `--agent`:

- the member cannot mail teammates, cannot ask you and cannot edit any `AGENT.md`;
- its own `done` mail ends the run, so it must send one;
- it is an ordinary run otherwise: it has a run id and the project lock, shows in `status`, and can be resumed (the run remembers that it is solo) and cleared;
- `--assume-defaults` has no effect;
- a name that is not a member is refused with the member list; a name that only exists in the global library is pointed to [call](#call).

In a git repo with a commit the run (solo `--agent` runs too) starts from `HEAD` in its own worktree and ends with a branch to merge (`git merge <branch>` or `open_pr`); elsewhere it works directly in the folder, one agent at a time. See "Several runs at once" in [How a run works](how-it-works.md#several-runs-at-once).

If the lead's done asks for a pull request (`open_pr: true`) and the run completes on its own branch, the run opens it; see "Opening a pull request" in [How a run works](how-it-works.md#opening-a-pull-request).

## call

**Usage:** `call <agent> ["task"] [--task-file f] [--dir d]`

Call one agent of the global library (`team.yaml`) on its own, **outside any project**: no `project.yaml` is read, no project lock is taken and nothing shows in `status`. The agent uses its global `AGENT.md` and its global memory. It may change files in the working directory and its own global memory; it cannot mail anyone or ask you.

Options:

- `"task"`: the task as text. Give this *or* `--task-file`.
- `--task-file f`: read the task from a file.
- `--dir d`: the directory the agent works in (default: the current directory). A directory inside or above the agent-lyceum home is refused, because a call lists only the called agent and could otherwise change other agents' files there.

Only the called agent's own `AGENT.md`, `COMMON.md` and the working directory's `CLAUDE.md`/`AGENTS.md` are checked: a change to one of them is put back and reported.

The agent's final reply is printed on stdout; everything else (progress, the call id) goes to stderr, so the answer can be piped. Each call keeps `task.md`, `log/` and `result.md` in `<home>/calls/<call-id>/` (nothing deletes them). Exit codes: `0` success, `1` failure or timeout (`dispatcher.wake_timeout_sec` default), `130` Ctrl-C. Only one call per agent can run at a time: a second one is refused while the first runs. A call cannot be resumed; call again.

If the agent has a `fallback` chain ([Fallback models](configuration.md#fallback-models)), a call falls back too, with the same kinds of failure as a run, but as a single shot: no retry on the same model, no wait, and its cooldowns end with the call. A failed call lists the models it tried in `result.md`.

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

**Project records:** with `--layer project` (the default) the lead's wake-up also tidies the project records (`shared/common/records/`), even if the lead has no memory dir; `--agent <lead>` includes them, `--agent <other>` and `--layer global` do not. Merged or obsolete entries move to `records/.archive/<timestamp>/` with a `tidy-report.md`; nothing is deleted. Any violation rolls back both the memory dir and the records, and the exit code is `1`. `--dry-run` also prints a records line (files, size, active entries per kind). `doctor` and `status` hint when a kind is over its 6 KB budget; `doctor` also warns about invalid frontmatter and unknown `supersedes` ids.

**`tidy --undo <timestamp>`** undoes one tidy: it moves the files of `memory/.archive/<timestamp>/` back to where they were and adds them to `MEMORY.md` if the index does not mention them. With `--agent <lead>` it also restores the records archive of that timestamp. `tidy` prints the timestamp, and the exact undo command, when it finishes.

- `--agent a`: whose memory to restore. Required.
- `--layer project|global`: which memory layer (default `project`).
- `--dry-run` cannot be combined with `--undo`.
- A file whose name exists now is not overwritten; it is reported and stays in the archive.

## Stopping a run

**Stopping a run:** Ctrl-C (or SIGTERM) cancels it cleanly: running agents get SIGTERM, then SIGKILL after 5 s (their whole process tree), unread mail is kept, the lock is released and the exit code is `130`; continue later with `agent-lyceum resume`. A second Ctrl-C quits at once. `npx`, `npm exec`/`npm run` and `tsx` do not pass SIGHUP on: if such a launcher exits (for example, the terminal is closed), `run`, `resume` and `call` are cancelled the same way (exit `130`), while `tidy` restores its snapshot and exits `1`. To keep a run going after its launcher exits, run the installed `agent-lyceum` binary directly; inside an npm script, which inherits `npm_execpath`, use `env -u npm_execpath agent-lyceum …`. A wake-up that exceeds `wake_timeout_sec` is stopped the same way as Ctrl-C and counts as a failed attempt. Each attempt's complete stdout/stderr is written to `runs/<run-id>/mail/attempts/<attempt>/log/`; only the last 64 KiB of each stream is kept in memory.

## Exit codes

**Exit codes of `run` / `resume`:** `0` only when the lead reported `outcome: completed`; `2` for `partial` or `blocked` (also when the run went idle or hit `max_rounds`, if you set one, without a done); `1` for `failed` (also when the lead or another agent kept failing and the run stopped: continue with `resume` after fixing the cause); `3` when the run is waiting for your answers (see [Answering questions](#answering-questions)); `130` for `cancelled`. *Upgrading:* before this version an `idle` run exited `0` and a failed lead exited `2`; scripts that treated `0` as "the run ended" must now check for `0` as "the work was completed". Runs that ended before outcomes were recorded show as unverified (`partial`) and are not reported as a success. For the exit codes of `call` (`0`, `1`, `130`), see [call](#call).

## Choosing the project

Without `--project`, the project is the registered one whose `dir` is the longest prefix of the current directory; if none matches the command lists the registered projects and stops.

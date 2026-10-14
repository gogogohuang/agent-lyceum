#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { Command } from "commander";
import { ConfigError, findProjectForCwd, flattenResolved, listProjects, loadGlobal, resolveProject, resolveProjectWithSources, type ResolvedProject, type SourceInfo } from "./config.js";
import { openInEditor, prepareAnswers } from "./ask-answer.js";
import { restoreMemory, tidyMemory, tidyStamp, type Layer } from "./memory-tidy.js";
import { RESULT_FILE, runTeam, type RunSummary } from "./dispatcher.js";
import { executeRunCleanup, planRunCleanup } from "./run-cleanup.js";
import { diagnoseProject, formatDoctor, preflightRuntimes } from "./doctor.js";
import { acquireProjectLock, forceUnlock, inspectRunLock, listRunLocks, listUnreadableRunLocks, LOCK_FILE, lockHolderAlive, type ProjectLease } from "./project-lock.js";
import { loadRunState, newRunId, outcomeOf, resolveRun, roundLimit, slugify, uniqueName, type RunRef } from "./run-store.js";
import { exitCodeForOutcome } from "./schema.js";
import { absPath, assertName, projectPaths, resolveHome } from "./paths.js";
import { addProject, initHome, removeProject } from "./scaffold.js";
import { buildStatusReport, buildTaskListReport, formatMonitor, formatRunDetail, formatStatusWithLog, formatTaskList, latestUnfinishedRun, listRuns, reopenCandidates, runIsAlive } from "./status.js";
import { prepareTask, readTaskFile, taskMessageBody } from "./task.js";
import { callAgent, callProject, callsDir, resolveCallAgent } from "./call.js";
import { formatEnforcement, validateProject } from "./validate.js";
import { must } from "./assert.js";
import { onlyAgent, soloProject } from "./solo.js";

const program = new Command();
program
  .name("agent-lyceum")
  .description("Configure and run a team of Claude Code / Codex agents with scoped context and file mailboxes.")
  .option("--home <dir>", "agent-lyceum home (default: $AGENT_LYCEUM_HOME or ~/agent-lyceum-config)");

const home = () => resolveHome(program.opts().home);

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

function loadProject(projectOpt: string | undefined): ResolvedProject {
  const h = home();
  let name = projectOpt;
  if (name) assertName("project", name);
  if (!name) {
    name = findProjectForCwd(h, process.cwd());
    if (!name) {
      const known = listProjects(h);
      fail(
        `No project given and the current directory is not inside a registered project.\n` +
          (known.length
            ? `Registered projects:\n${known.map((p) => `  ${p.name}  ->  ${p.dir}`).join("\n")}\nUse --project <name>.`
            : `No projects registered. Use: agent-lyceum project add <name> --dir <repo>`),
      );
    }
  }
  if (!fs.existsSync(projectPaths(h, name).config)) fail(`Project "${name}" is not registered in ${h}.`);
  return resolveProject(h, name);
}

program
  .command("init")
  .description("Create the agent-lyceum home with a global agent library")
  .option("-y, --yes", "do not ask for confirmation of the home path")
  .action(async (opts: { yes?: boolean }) => {
    const h = home();
    const explicit = program.opts().home || process.env.AGENT_LYCEUM_HOME;
    if (!opts.yes && !explicit && !fs.existsSync(h) && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await rl.question(`Create agent-lyceum home at ${h}? [Y/n] `)).trim().toLowerCase();
      rl.close();
      if (ans === "n" || ans === "no") fail("Aborted. Set AGENT_LYCEUM_HOME or pass --home to choose another location.");
    }
    const r = initHome(h);
    console.log(`Home: ${r.home}`);
    for (const f of r.created) console.log(`  created  ${path.relative(h, f)}`);
    for (const f of r.skipped) console.log(`  kept     ${path.relative(h, f)}`);
    console.log(`\nNext: agent-lyceum project add <name> --dir <your-repo>`);
  });

const project = program
  .command("project")
  .summary("List registered projects, or add / remove one")
  .description("Without a subcommand, list the registered projects.\n\nSubcommands:\n  - add <name> --dir <repo>: register a project\n  - remove <name> [--purge]: unregister one")
  .action(() => {
    const list = listProjects(home());
    if (!list.length) console.log("No projects registered.");
    for (const p of list) console.log(`${p.name}  ->  ${p.dir}`);
  });
project
  .command("add <name>")
  .description("Register a project (config and context live in the home, not in the repo)")
  .requiredOption("--dir <repo>", "the repo agents will work in")
  .action((name: string, opts: { dir: string }) => {
    try {
      const r = addProject(home(), name, opts.dir);
      console.log(`Project "${name}" created: ${r.config}\nEdit it, then run: agent-lyceum doctor --project ${name}`);
    } catch (e) {
      fail((e as Error).message);
    }
  });
project
  .command("remove <name>")
  .description("Unregister a project (keeps its context unless --purge)")
  .option("--purge", "also delete all of the project's context")
  .action((name: string, opts: { purge?: boolean }) => {
    try {
      assertName("project", name);
      console.log(removeProject(home(), name, !!opts.purge));
    } catch (e) {
      fail((e as Error).message);
    }
  });

/** Ask the runtime CLIs what they support: refuse to start when something the team needs is explicitly missing, warn when unknown. */
async function preflight(pr: ResolvedProject): Promise<void> {
  const r = await preflightRuntimes(pr);
  for (const w of r.warnings) console.error(`warn   ${w}`);
  if (r.errors.length) fail(`${r.errors.map((e) => `ERROR  ${e}`).join("\n")}\nFix the above (see \`agent-lyceum doctor\`).`);
}

/** The run a user typed: full id, name or unique prefix. Exits with the candidates when it is unknown or ambiguous. */
function findRun(pr: ResolvedProject, query: string): RunRef {
  if (!query.trim()) return fail("Give a run id or name (see `agent-lyceum status --task-list`).");
  assertName("run", query);
  const r = resolveRun(listRuns(pr, Infinity), query);
  if (r.ok) return r.run;
  if (r.reason === "none") return fail(`Run "${query}" not found in ${pr.paths.runs}. List runs with: agent-lyceum status --task-list`);
  const list = r.candidates.map((c) => `  ${c.state.name ?? "(no name)"}  ${c.state.run_id}  ${c.state.task_summary}`).join("\n");
  return fail(`"${query}" matches several runs:\n${list}\nGive more of the name or id.`);
}

/** Take the lock of one run, or exit with the reason. `ignoreLimit`: the caller does not start a run (e.g. `clear`). `exclusive`: it needs the whole project (memory tidy). */
function takeLock(pr: ResolvedProject, runId: string, opts: { ignoreLimit?: boolean; exclusive?: boolean } = {}): ProjectLease {
  try {
    return acquireProjectLock(pr.paths.root, runId, { maxConcurrent: opts.ignoreLimit ? Number.MAX_SAFE_INTEGER : pr.dispatcher.max_concurrent_runs, exclusive: opts.exclusive });
  } catch (e) {
    return fail((e as Error).message);
  }
}

/**
 * Ctrl-C (or SIGTERM) stops the run cleanly: the first signal cancels it (agents are killed, unread mail is kept,
 * the lock is released, exit code 130); a second one quits at once.
 */
function cancelOnSignals(): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  let seen = 0;
  const handler = (name: string) => () => {
    if (++seen === 1) {
      console.error(`\n${name}: stopping the run (running agents are being stopped; unread mail is kept). Press Ctrl-C again to quit at once.`);
      ac.abort();
    } else process.exit(130);
  };
  const onInt = handler("Interrupted");
  const onTerm = handler("Terminated");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return { signal: ac.signal, dispose: () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    },
  };
}

function printRun(summary: RunSummary, runDir: string): void {
  console.log(`\nRun ${summary.name ?? summary.runId} ended: ${summary.endReason}, outcome: ${summary.outcome}, after ${summary.rounds} round(s). Logs: ${path.join(runDir, "log.jsonl")}`);
  if (summary.outcomeNote) console.log(`Note: ${summary.outcomeNote}`);
  if (summary.verification) console.log(`Verification (as reported by the lead, not checked by agent-lyceum): ${summary.verification}`);
  if (summary.resultBranch?.files) {
    console.log(`\nThe work is on branch ${summary.resultBranch.branch} (${summary.resultBranch.files} file(s)); your working tree was not touched.\nBring it in with: git merge ${summary.resultBranch.branch}${summary.resultBranch.patch ? `\n(or apply the patch: git apply ${summary.resultBranch.patch})` : ""}`);
  }
  if (summary.pr) {
    if (summary.pr.status === "opened") console.log(`\nPull request opened: ${summary.pr.url}`);
    else if (summary.pr.status === "skipped") console.log(`\nA pull request was asked for but not opened: ${summary.pr.reason}`);
    else console.log(`\nThe pull request could not be opened (${summary.pr.step}: ${summary.pr.reason}).${summary.pr.manual.length ? ` To finish by hand:\n${summary.pr.manual.map((m) => `  ${m}`).join("\n")}` : ""}`);
  }
  if (summary.doneMessage) {
    console.log(`\nLead's final message — ${summary.doneMessage.subject}\n\n${summary.doneMessage.body}`);
    console.log(`\nResult saved to: ${path.join(runDir, RESULT_FILE)}`);
  }
}

function reportRun(summary: RunSummary, runDir: string): never {
  printRun(summary, runDir);
  process.exit(exitCodeForOutcome(summary.outcome));
}

const firstLine = (t: string): string => t.trim().split("\n")[0]!.trim();

/** Take the lock and continue a run; the lock is released when it stops (also when it stops because it waits for answers). */
async function continueRun(pr: ResolvedProject, dir: string, runId: string, followup?: { text: string }): Promise<RunSummary> {
  const lease = takeLock(pr, runId);
  const cancel = cancelOnSignals();
  try {
    console.log(`Project ${pr.name} — repo ${pr.dir}`);
    const state = loadRunState(dir);
    if (followup) console.log(`Reopening run ${state.name ?? state.run_id} (follow-up ${(state.reopened?.length ?? 0) + 1}): ${firstLine(followup.text)}`);
    else console.log(`Resuming run ${state.run_id} (${state.end_reason ?? "interrupted"}) at round ${state.rounds}/${roundLimit(state, pr.dispatcher.max_rounds)}: ${state.task_summary}`);
    // Read the state again under the lock: another process may have changed it while we were checking.
    return await runTeam({ project: pr, resume: state, runDir: dir, signal: cancel.signal, followup });
  } finally {
    cancel.dispose();
    lease.release();
  }
}

const interactive = (): boolean => !!process.stdin.isTTY && !!process.stdout.isTTY;

function printWaiting(pr: ResolvedProject, runId: string, file: string, problems: string[]): void {
  console.log(`\nRun ${runId} is waiting for your answers.\n  File: ${file}`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log(`Answer with: agent-lyceum resume ${runId} --answer -p ${pr.name}   (or edit the file, then: agent-lyceum resume ${runId} -p ${pr.name})`);
}

/**
 * Keep going while the run stops to ask and the questions can be settled right now: by --assume-defaults, or (in a terminal)
 * by opening the editor. Otherwise print where to answer and exit 3.
 */
async function driveRun(pr: ResolvedProject, runDir: string, first: RunSummary, assumeDefaults: boolean): Promise<never> {
  let summary = first;
  while (summary.outcome === "waiting") {
    let prep = prepareAnswers(runDir, { assumeDefaults });
    while (!prep.complete && interactive()) {
      console.log(`\nRun ${summary.runId} needs your answers (${prep.path}).`);
      openInEditor(prep.path);
      prep = prepareAnswers(runDir, {});
      if (prep.complete) break;
      console.log("Some answers are missing or invalid:");
      for (const p of prep.problems) console.log(`  - ${p}`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const again = (await rl.question("Edit again? [Y/n] ")).trim().toLowerCase();
      rl.close();
      if (again === "n" || again === "no") break;
    }
    if (!prep.complete) {
      printRun(summary, runDir);
      printWaiting(pr, summary.runId, prep.path, prep.problems);
      process.exit(3);
    }
    summary = await continueRun(pr, runDir, summary.runId);
  }
  return reportRun(summary, runDir);
}

program
  .command("run [task]")
  .summary("Start the dispatcher with a task for the lead")
  .description('Start the dispatcher: give the task to the lead.\n\nGive the task either way:\n  - "<task>": as text\n  - --task-file <path>: from a file\n\nWho gets it:\n  - by default, the lead\n  - --agent <name>: that one member alone')
  .option("-p, --project <name>")
  .option("--task-file <path>", "read the task from a file")
  .option("--agent <name>", "run only this member of the project, alone: it cannot mail teammates or ask you, and its own `done` ends the run")
  .option("--name <name>", "name for this run (default: made from the task)")
  .option("--assume-defaults", "when the run stops to ask, use the suggested answer for every question that has one")
  .action(async (task: string | undefined, opts: { project?: string; taskFile?: string; agent?: string; name?: string; assumeDefaults?: boolean }) => {
    try {
      const pr = loadProject(opts.project);
      const res = validateProject(pr);
      for (const i of res.issues) console.error(`${i.level === "error" ? "ERROR" : "warn "}  ${i.message}`);
      if (!res.ok) fail("Configuration is invalid; fix the errors above (see `agent-lyceum doctor`).");
      let checked = pr;
      if (opts.agent) {
        assertName("agent", opts.agent);
        if (opts.assumeDefaults) console.error("warn   --assume-defaults is ignored with --agent: a solo agent cannot ask questions.");
        // Fails with the member list (and a hint for a global-only agent) before anything is written.
        const sp = soloProject(pr, opts.agent, { globalAgents: Object.keys(loadGlobal(home()).agents) });
        checked = onlyAgent(sp, opts.agent);
      }
      await preflight(checked);

      const taken = listRuns(pr, Infinity).flatMap((r) => (r.state.name ? [r.state.name] : []));
      if (opts.name !== undefined) {
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(opts.name) || opts.name.length > 30) fail(`Invalid run name "${opts.name}": use lowercase letters, digits and "-", at most 30 characters.`);
        if (taken.includes(opts.name)) fail(`A run named "${opts.name}" already exists in project ${pr.name}.`);
      }

      const runId = newRunId();
      const runDir = path.join(pr.paths.runs, runId);
      const lease = takeLock(pr, runId);
      let summary: RunSummary;
      const cancel = cancelOnSignals();
      try {
        const prepared = prepareTask({ text: task, file: opts.taskFile, cwd: process.cwd(), runDir });
        console.log(`Project ${pr.name} — repo ${pr.dir}${opts.agent ? ` — solo: ${opts.agent}` : ""}`);
        console.log(`Task: ${prepared.source === "file" ? `file ${prepared.sourcePath}` : "text"} (${prepared.bytes} bytes${prepared.inline ? "" : ", passed by reference"})`);
        const name = opts.name ?? uniqueName(slugify(taskMessageBody(prepared).subject), taken);
        summary = await runTeam({ project: pr, name, task: prepared, runDir, soloAgent: opts.agent, signal: cancel.signal });
      } finally {
        cancel.dispose();
        lease.release();
      }
      await driveRun(pr, runDir, summary, !!opts.assumeDefaults);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });

/** With a follow-up text and no run named: the one finished run to reopen. Several: ask in a terminal, otherwise list them. Never guesses. */
async function pickReopenRun(pr: ResolvedProject): Promise<RunRef> {
  const cands = reopenCandidates(pr);
  if (cands.length === 0) return fail('No run to continue. Start one with: agent-lyceum run "<task>"');
  if (cands.length === 1) return cands[0]!;
  const label = (c: RunRef) => `${c.state.name ?? c.state.run_id}  [${c.state.end_reason ?? "interrupted"}]  ${firstLine(c.state.task_summary)}`;
  if (!interactive()) {
    return fail(`Several runs could take this follow-up:\n${cands.map((c) => `  ${c.state.name ? `${c.state.name}  ` : ""}${c.state.run_id}  [${c.state.end_reason ?? "interrupted"}]  ${firstLine(c.state.task_summary)}`).join("\n")}\nName one: agent-lyceum resume <name> "..."`);
  }
  console.log("Which run should get the follow-up?");
  for (const [i, c] of cands.entries()) console.log(`  ${i + 1}) ${label(c)}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Number or name: ")).trim();
  rl.close();
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= cands.length) return cands[n - 1]!;
  const r = resolveRun(cands, answer);
  if (r.ok) return r.run;
  return fail(`"${answer}" is not one of the listed runs.`);
}

program
  .command("resume [run] [text]")
  .summary("Continue an interrupted run, or reopen a finished one with a follow-up")
  .description(
    'Continue an interrupted (or failed) run: same run dir, sessions and round count; the task is not re-sent.\nOr reopen a finished run with a follow-up request: the lead gets the text as a new task and the run goes on with its memory and worktree.\n\nUsage:\n  - resume                    the newest run that is not done or running\n  - resume <run>              that run (full id, name or unique prefix); a finished run only prints its result\n  - resume <run> "<text>"     reopen that finished run with the follow-up\n  - resume "<text>"           if the one argument is not a run, it is the follow-up; the run is chosen among the runs that are not running\n                              (the only one, or you pick one in a terminal; without a terminal the candidates are listed and it fails)\n                              a one-word follow-up looks like a run name: use resume <run> "<text>" or --task-file\n  - --task-file <path>        read the follow-up from a file instead of an argument',
  )
  .option("-p, --project <name>")
  .option("--task-file <path>", "read the follow-up text from a file (reopens a finished run)")
  .option("--answer", "the run is waiting for answers: open ask-reply.md in $EDITOR, check the answers, then continue")
  .option("--no-edit", "with --answer: do not open the editor; check the file as it is")
  .option("--assume-defaults", "if the run waits for answers, use the suggested answer for every unanswered question that has one")
  .action(async (runArg: string | undefined, textArg: string | undefined, opts: { project?: string; taskFile?: string; answer?: boolean; edit: boolean; assumeDefaults?: boolean }) => {
    try {
      const pr = loadProject(opts.project);
      const res = validateProject(pr);
      for (const i of res.issues) console.error(`${i.level === "error" ? "ERROR" : "warn "}  ${i.message}`);
      if (!res.ok) fail("Configuration is invalid; fix the errors above (see `agent-lyceum doctor`).");

      let text = textArg;
      let query = runArg;
      if (opts.taskFile) {
        if (textArg !== undefined) fail("Give the follow-up either as text or with --task-file, not both.");
        text = readTaskFile(path.resolve(process.cwd(), opts.taskFile));
      } else if (query !== undefined && textArg === undefined) {
        // One argument: a run if it names one. It is follow-up text only if it cannot be a run reference (whitespace or a character outside [A-Za-z0-9._-]);
        // a mistyped run name must not silently become the task. An ambiguous match is still an error.
        const r = query.trim() ? resolveRun(listRuns(pr, Infinity), query) : undefined;
        if (r && !r.ok && r.reason === "none" && /[^A-Za-z0-9._-]/.test(query)) {
          text = query;
          query = undefined;
        }
      }
      if (text !== undefined && !text.trim()) fail("The follow-up text is empty.");

      let found: RunRef | undefined;
      if (query !== undefined) {
        found = findRun(pr, query);
      } else if (text !== undefined) {
        found = await pickReopenRun(pr);
      } else {
        found = latestUnfinishedRun(pr);
        if (!found) fail("No unfinished run to resume. Start one with: agent-lyceum run \"<task>\"");
      }
      const { dir, state } = found!;
      // A solo run needs only its own agent's runtime, as when it started.
      await preflight(state.solo_agent ? onlyAgent(soloProject(pr, state.solo_agent), state.solo_agent) : pr);
      if (!state.end_reason && runIsAlive(state, pr)) fail(`Run ${state.run_id} is still running (pid ${state.pid}).`);
      const reopen = text !== undefined;
      if (reopen && state.end_reason !== "done")
        fail(`Run ${state.name ?? state.run_id} is not finished (${state.end_reason ?? "interrupted"}); resume it without text first, then follow up.`);
      if (!reopen && state.end_reason === "done") {
        const result = path.join(dir, RESULT_FILE);
        if (!fs.existsSync(result)) fail(`Run ${state.run_id} already finished (done); nothing to resume.`);
        const o = outcomeOf(state)!;
        console.log(`Run ${state.run_id} already finished (done); nothing to resume. Outcome: ${o.outcome}${o.verified ? "" : " (not verified: this run ended before outcomes were recorded)"}. Result: ${result}\n\n${fs.readFileSync(result, "utf8")}`);
        process.exit(exitCodeForOutcome(o.outcome));
      }
      // A reopen recalculates the round limit from where the run stands.
      if (!reopen && state.rounds >= roundLimit(state, pr.dispatcher.max_rounds))
        fail(`Run ${state.run_id} used ${state.rounds}/${roundLimit(state, pr.dispatcher.max_rounds)} rounds; raise dispatcher.max_rounds in project.yaml first.`);

      if (opts.answer && state.end_reason !== "waiting") fail(`Run ${state.run_id} is not waiting for answers (${state.end_reason ?? "not finished"}).`);
      if (state.end_reason === "waiting") {
        if (opts.answer && opts.edit) openInEditor(prepareAnswers(dir, {}).path);
        const prep = prepareAnswers(dir, { assumeDefaults: !!opts.assumeDefaults });
        if (!prep.complete) {
          printWaiting(pr, state.run_id, prep.path, prep.problems);
          process.exit(3);
        }
      }
      const summary = await continueRun(pr, dir, state.run_id, reopen ? { text: text! } : undefined);
      await driveRun(pr, dir, summary, !!opts.assumeDefaults);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });

/** Color when writing to a terminal, unless NO_COLOR is set; FORCE_COLOR overrides. */
/** `clear --lock [run-id]`: show who holds a run lock; remove it only with --force. With several locks, name the run. */
function unlockProject(pr: ResolvedProject, runId: string | undefined, force: boolean): void {
  const root = pr.paths.root;
  const locks = listRunLocks(root);
  const unreadable = listUnreadableRunLocks(root);
  if (runId && unreadable.includes(runId)) {
    console.log(`The lock file of run ${runId} exists but cannot be read.`);
    if (!force) fail("Not removed. Check that no run is active, then repeat with --force.");
    forceUnlock(root, runId);
    console.log(`Lock removed. Resume the run with: agent-lyceum resume ${runId}`);
    return;
  }
  if (!runId && unreadable.length && locks.length + unreadable.length > 1) {
    const list = [...locks.map((l) => `  ${l.run_id}  pid ${l.pid}${lockHolderAlive(l) ? " (alive)" : " (gone)"}`), ...unreadable.map((id) => `  ${id}  (lock file cannot be read)`)].join("\n");
    fail(`Several runs hold a lock:\n${list}\nName the one to unlock: agent-lyceum clear --lock <run-id> --force`);
  }
  if (!runId && unreadable.length && !locks.length) {
    fail(`The lock file of run ${unreadable[0]} cannot be read. Name it to remove it: agent-lyceum clear --lock ${unreadable[0]} --force`);
  }
  if (!runId && locks.length > 1) {
    const list = locks.map((l) => `  ${l.run_id}  pid ${l.pid}${lockHolderAlive(l) ? " (alive)" : " (gone)"}`).join("\n");
    fail(`Several runs hold a lock:\n${list}\nName the one to unlock: agent-lyceum clear --lock <run-id> --force`);
  }
  const target = runId ?? locks[0]?.run_id;
  if (!target) {
    if (!fs.existsSync(path.join(root, LOCK_FILE))) {
      console.log(`Project ${pr.name} has no run lock.`);
      return;
    }
    console.log("The lock file exists but cannot be read.");
    if (!force) fail("Not removed. Check that no run is active, then repeat with --force.");
    forceUnlock(root);
    console.log("Lock removed.");
    return;
  }
  const info = inspectRunLock(root, target);
  if (!info) fail(`Run "${target}" holds no readable lock. List the locks with: agent-lyceum doctor`);
  console.log(`Lock held for run ${info!.run_id} by pid ${info!.pid} on ${info!.hostname}, last heartbeat ${info!.heartbeat_at}${lockHolderAlive(info!) ? " (that process is still alive)" : " (that process is gone)"}.`);
  if (!force) fail("Not removed. Check that no run is active, then repeat with --force.");
  forceUnlock(root, target);
  console.log(`Lock removed. Resume the run with: agent-lyceum resume ${target}`);
}

program
  .command("clear [run-id]")
  .summary("Delete a run by id, or remove a stale run lock")
  .description(
    "Delete a task (run) by id: its run directory (state, log, result, mailboxes), its task memory and its agent worktrees, branches and snapshots.\n\n" +
      "Long-term (global and project) memory is never touched.\n" +
      "Refuses while the run is running, or while a worktree holds work that is not in the repo.\n\n" +
      "With --lock it does something else (the run id is optional):\n" +
      "  - removes the run lock a crashed run left behind (name the run when several hold a lock)\n" +
      "  - needs --force to actually remove it",
  )
  .option("-p, --project <name>")
  .option("--dry-run", "only list what would be deleted and what would be kept")
  .option("--lock", "remove the run lock left behind by a crashed run (give its run id when several runs hold a lock; needs --force)")
  .option("--force", "with --lock: remove the lock even though its owner cannot be confirmed dead")
  .option("--keep-worktrees", "keep the agents' worktrees and branches (and their snapshots), and still clear the run and its task memory")
  .action((runId: string | undefined, opts: { project?: string; dryRun?: boolean; keepWorktrees?: boolean; lock?: boolean; force?: boolean }) => {
    try {
      if (opts.lock) {
        if (runId) assertName("run", runId);
        return unlockProject(loadProject(opts.project), runId, !!opts.force);
      }
      if (opts.force) fail("--force only goes with --lock.");
      if (!runId) fail("Give the run id to clear (see `agent-lyceum status --task-list`), or use --lock.");
      const pr = loadProject(opts.project);
      const full = findRun(pr, runId).state.run_id;
      const showPlan = (plan: ReturnType<typeof planRunCleanup>) => {
        console.log(`Run ${plan.summary}`);
        for (const i of plan.items) console.log(`  ${opts.dryRun ? "would delete" : "delete      "}  ${i.label}`);
        for (const k of plan.keep) console.log(`  kept          worktree of ${k.agent}: ${k.path} (branch ${k.branch})${k.files.length ? `, holding ${k.files.join(", ")}` : ""}`);
      };
      const refuse = (plan: ReturnType<typeof planRunCleanup>): never => {
        for (const r of plan.refusals) console.error(`REFUSED  ${r}`);
        return fail("Nothing was deleted.");
      };
      if (opts.dryRun) {
        const plan = planRunCleanup(pr, full, { keepWorktrees: opts.keepWorktrees });
        console.log("Dry run: nothing is deleted.");
        showPlan(plan);
        if (plan.refusals.length) refuse(plan);
        return;
      }
      const lease = takeLock(pr, full, { ignoreLimit: true });
      try {
        const plan = planRunCleanup(pr, full, { keepWorktrees: opts.keepWorktrees });
        if (plan.refusals.length) refuse(plan);
        showPlan(plan);
        const report = executeRunCleanup(plan);
        if (report.failed.length) {
          for (const f of report.failed) console.error(`FAILED  ${f.item.label}: ${f.error}`);
          fail("Cleanup stopped at the first failure; fix it and repeat the same command to finish.");
        }
        console.log(`Deleted run ${full}: ${plan.summary.slice(full.length + 2)}`);
      } finally {
        lease.release();
      }
    } catch (e) {
      fail((e as Error).message);
    }
  });

program
  .command("doctor")
  .summary("Check the setup without running any agent")
  .description("Check the setup without running any agent. It checks:\n  - configuration and enforcement levels\n  - git\n  - the project lock\n  - what each runtime CLI supports (read from its --version and --help)\n\nWith --resolved it checks nothing and instead prints:\n  - every effective setting\n  - where each one came from")
  .option("-p, --project <name>")
  .option("--task-file <path>", "also check a task file")
  .option("--resolved", "print the merged settings (global library, project file, defaults) and their sources; runs no other check")
  .option("--json", "print the report as JSON")
  .action(async (opts: { project?: string; taskFile?: string; resolved?: boolean; json?: boolean }) => {
    try {
      if (opts.resolved) {
        printResolved(opts.project, !!opts.json);
        return;
      }
      const pr = loadProject(opts.project);
      const report = await diagnoseProject(pr);
      let taskError: string | undefined;
      if (opts.taskFile) {
        try {
          readTaskFile(absPath(opts.taskFile, process.cwd()));
        } catch (e) {
          taskError = (e as Error).message;
          report.checks.push({ level: "error", subject: "task", message: taskError });
          report.ok = false;
        }
      }
      if (opts.json) console.log(JSON.stringify({ schema_version: 1, ...report }, null, 2));
      else console.log(`${formatEnforcement(validateProject(pr).enforcement)}\n\n${formatDoctor(report)}`);
      process.exit(report.ok ? 0 : 1);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });

/** `doctor --resolved`: every effective setting with the file and key it came from. */
function printResolved(projectName: string | undefined, json: boolean): void {
  const h = home();
  const pr = loadProject(projectName);
  const { project, sources } = resolveProjectWithSources(h, pr.name);
  const values = flattenResolved(project);
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, project: project.name, values, sources }, null, 2));
    return;
  }
  const rel = (f: string) => path.relative(h, f) || f;
  const where = (s: SourceInfo): string => ("default" in s ? "default" : "inferred_from" in s ? `inferred from ${s.inferred_from.key} (${rel(s.inferred_from.file)})` : rel(s.file));
  const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  const keys = Object.keys(sources).filter((k) => values[k] !== undefined);
  const w = Math.max(...keys.map((k) => `${k} = ${show(values[k])}`.length));
  for (const k of keys) console.log(`${`${k} = ${show(values[k])}`.padEnd(w)}   ${where(must(sources[k], `source of ${k}`))}`);
}

program
  .command("call <agent> [task]")
  .summary("Call one global-library agent on its own, outside any project")
  .description("Call one agent of the global library on its own, outside any project.\n\n  - it works in --dir (default: the current directory)\n  - its final answer is printed\n  - it cannot mail anyone or ask you")
  .option("--task-file <path>", "read the task from a file")
  .option("--dir <path>", "the directory the agent works in (default: the current directory)")
  .action(async (agentName: string, task: string | undefined, opts: { taskFile?: string; dir?: string }) => {
    try {
      if (task !== undefined && opts.taskFile) fail("Give the task either as text or with --task-file, not both.");
      const text = opts.taskFile ? readTaskFile(absPath(opts.taskFile, process.cwd())) : task;
      if (!text?.trim()) fail("Give the task as text or with --task-file.");
      const h = home();
      const dir = absPath(opts.dir ?? ".", process.cwd());
      const agent = resolveCallAgent(h, agentName);
      await preflight(callProject(h, agent, dir, path.join(callsDir(h), "preflight")));

      const cancel = cancelOnSignals();
      let r: Awaited<ReturnType<typeof callAgent>>;
      try {
        r = await callAgent({ home: h, agent: agentName, task: text, dir, signal: cancel.signal });
      } finally {
        cancel.dispose();
      }
      console.error(`Call ${r.callId}: ${r.callDir}`);
      if (r.cancelled) fail("Cancelled.", 130);
      if (!r.ok) fail(`Call failed: ${r.error}\nLog: ${path.join(r.callDir, "log")}`);
      console.log(r.text.trimEnd());
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });

function layerOpt(v: string | undefined): Layer {
  if (v === undefined || v === "project") return "project";
  if (v === "global") return "global";
  return fail(`--layer must be "project" or "global" (task memory is not tidied: \`clear\` deletes it).`);
}

program
  .command("tidy")
  .summary("Have agents tidy their own memory, or undo one tidy")
  .description(
    "Have agents tidy their own memory: merge duplicates, fix stale entries, archive what is obsolete (never deletes).\n\n" +
      "Manual only; nothing triggers it automatically.\n\n" +
      "With --undo <stamp> it tidies nothing and instead:\n" +
      "  - moves that tidy's archived files back (never overwrites)\n" +
      "  - re-adds them to MEMORY.md\n" +
      "  - needs --agent, and cannot be combined with --dry-run",
  )
  .option("-p, --project <name>")
  .option("--agent <name>", "tidy only this agent (default: every agent); required with --undo")
  .option("--layer <layer>", "project (default) or global; global memory is shared by every project, so it is never tidied unless you ask")
  .option("--dry-run", "only show the memory sizes and what changed in the project; wake nobody, change nothing")
  .option("--undo <stamp>", "undo the tidy with this timestamp: move its archived files back")
  .action(async (opts: { project?: string; agent?: string; layer?: string; dryRun?: boolean; undo?: string }) => {
    try {
      const layer = layerOpt(opts.layer);
      if (opts.undo !== undefined) {
        if (opts.dryRun) fail("--undo cannot be combined with --dry-run.");
        if (!opts.agent) fail("--undo needs --agent <name>: an archive belongs to one agent's memory.");
        const target = loadProject(opts.project);
        const undoLease = takeLock(target, `restore-${tidyStamp()}`, { exclusive: true });
        try {
          const r = restoreMemory({ project: target, agent: opts.agent, layer, stamp: opts.undo });
          for (const f of r.restored) console.log(`  restored  ${f}`);
          for (const s of r.skipped) console.log(`  skipped   ${s.rel}: ${s.reason}`);
          if (!r.restored.length && !r.skipped.length) console.log(`Archive ${opts.undo} holds no files to restore.`);
        } finally {
          undoLease.release();
        }
        return;
      }
      const pr = loadProject(opts.project);
      if (opts.dryRun) {
        const dry = await tidyMemory({ project: pr, layer, agent: opts.agent, dryRun: true });
        if (dry.length === 0) console.log(`No agent has ${layer} memory configured. ${layer === "project" ? "The template gives agents global memory only: set `memory.project` for an agent in project.yaml (or use --layer global)." : "Set `memory.global` for an agent."}`);
        return;
      }
      const res = validateProject(pr);
      for (const i of res.issues) console.error(`${i.level === "error" ? "ERROR" : "warn "}  ${i.message}`);
      if (!res.ok) fail("Configuration is invalid; fix the errors above (see `agent-lyceum doctor`).");
      await preflight(pr);
      const lease = takeLock(pr, `tidy-${tidyStamp()}`, { exclusive: true });
      const cancel = cancelOnSignals();
      let results: Awaited<ReturnType<typeof tidyMemory>>;
      try {
        results = await tidyMemory({ project: pr, layer, agent: opts.agent, signal: cancel.signal });
      } finally {
        cancel.dispose();
        lease.release();
      }
      if (results.length === 0) console.log(`No agent has ${layer} memory configured. ${layer === "project" ? "The template gives agents global memory only: set `memory.project` for an agent in project.yaml (or tidy global memory with --layer global)." : "Set `memory.global` for an agent."}`);
      for (const r of results) {
        if (r.status === "tidied") console.log(`  ${r.agent} (${r.layer}): tidied. Archive: ${path.join(r.dir, ".archive", r.archive ?? "")} — undo with: agent-lyceum tidy --undo ${r.archive} -p ${pr.name} --agent ${r.agent}${r.layer === "global" ? " --layer global" : ""}`);
        else if (r.status === "skipped") console.log(`  ${r.agent} (${r.layer}): skipped — ${r.problems.join("; ")}`);
        else if (r.status === "failed") {
          console.error(`  ${r.agent} (${r.layer}): FAILED, memory restored to how it was`);
          for (const p of r.problems) console.error(`    - ${p}`);
        }
      }
      process.exit(results.some((r) => r.status === "failed") ? 1 : 0);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return process.env.FORCE_COLOR !== "0";
  return !!process.stdout.isTTY;
}

program
  .command("status")
  .description("Show agents, unread mail and the last run")
  .option("-p, --project <name>")
  .option("--task-list [project]", "list every task (run) of the project with its id and state")
  .option("--task-id <id>", "show everything about one task (run): every wake and its result")
  .option("--monitor", "keep the page open and refresh it (Ctrl-C to quit)")
  .option("--interval <sec>", "refresh interval for --monitor", "2")
  .option("--json", "print the report as JSON (no colour); works with --task-list and --task-id")
  .action(async (opts: { project?: string; taskList?: string | boolean; taskId?: string; monitor?: boolean; interval: string; json?: boolean }) => {
    try {
      const pr = loadProject(typeof opts.taskList === "string" ? opts.taskList : opts.project);
      if (opts.json) {
        if (opts.monitor) fail("--json cannot be combined with --monitor.");
        const report = opts.taskList ? buildTaskListReport(pr) : buildStatusReport(pr, opts.taskId !== undefined ? findRun(pr, opts.taskId).state.run_id : undefined);
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      if (opts.taskList) {
        console.log(formatTaskList(pr, useColor()));
        return;
      }
      if (opts.taskId !== undefined) {
        console.log(formatRunDetail(findRun(pr, opts.taskId), Date.now(), useColor(), pr));
        return;
      }
      if (!opts.monitor) {
        console.log(formatStatusWithLog(pr, Date.now(), useColor()));
        return;
      }
      const sec = Number(opts.interval);
      if (!(sec > 0)) fail("--interval must be a positive number of seconds.");
      const draw = () => {
        // Reload each tick so new mail, config edits and runs show up.
        let text: string;
        try {
          text = formatMonitor(loadProject(opts.project), Date.now(), useColor());
        } catch (e) {
          text = `(error: ${(e as Error).message})`;
        }
        process.stdout.write(`\x1b[2J\x1b[H${text}\n\nRefreshing every ${sec}s — ${new Date().toLocaleTimeString()} — Ctrl-C to quit\n`);
      };
      draw();
      setInterval(draw, sec * 1000);
      await new Promise(() => {});
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });

// `--help` lists the commands in three layers.
const HELP_LAYERS: Record<string, string[]> = {
  "Project:": ["init", "project"],
  "Diagnose:": ["doctor", "status"],
  "Run:": ["run", "resume", "clear", "call", "tidy"],
};
for (const [heading, names] of Object.entries(HELP_LAYERS)) for (const c of program.commands) if (names.includes(c.name())) c.helpGroup(heading);

program.parseAsync().catch((e) => fail((e as Error).message));


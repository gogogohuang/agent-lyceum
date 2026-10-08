#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { Command } from "commander";
import { ConfigError, findProjectForCwd, flattenResolved, listProjects, resolveProject, resolveProjectWithSources, type ResolvedProject, type SourceInfo } from "./config.js";
import { openInEditor, prepareAnswers } from "./ask-answer.js";
import { RESULT_FILE, runTeam, type RunSummary } from "./dispatcher.js";
import { executeRunCleanup, planRunCleanup } from "./run-cleanup.js";
import { diagnoseProject, formatDoctor, preflightRuntimes } from "./doctor.js";
import { acquireProjectLock, forceUnlock, inspectProjectLock, lockHolderAlive, type ProjectLease } from "./project-lock.js";
import { loadRunState, newRunId, outcomeOf } from "./run-store.js";
import { exitCodeForOutcome } from "./schema.js";
import { absPath, assertName, projectPaths, resolveHome } from "./paths.js";
import { addProject, initHome, removeProject } from "./scaffold.js";
import { buildStatusReport, buildTaskListReport, formatMonitor, formatRunDetail, formatStatusWithLog, formatTaskList, latestUnfinishedRun, runIsAlive } from "./status.js";
import { prepareTask, readTaskFile } from "./task.js";
import { formatEnforcement, validateProject } from "./validate.js";
import { must } from "./assert.js";

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

const project = program.command("project").description("Manage registered projects");
project
  .command("add <name>")
  .description("Register a project (config and context live in the home, not in the repo)")
  .requiredOption("--dir <repo>", "the repo agents will work in")
  .action((name: string, opts: { dir: string }) => {
    try {
      const r = addProject(home(), name, opts.dir);
      console.log(`Project "${name}" created: ${r.config}\nEdit it, then run: agent-lyceum validate --project ${name}`);
    } catch (e) {
      fail((e as Error).message);
    }
  });
project
  .command("list")
  .description("List registered projects")
  .action(() => {
    const list = listProjects(home());
    if (!list.length) console.log("No projects registered.");
    for (const p of list) console.log(`${p.name}  ->  ${p.dir}`);
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

program
  .command("validate")
  .description("Validate the merged configuration and report enforcement levels")
  .option("-p, --project <name>")
  .option("--task-file <path>", "also check a task file")
  .action((opts: { project?: string; taskFile?: string }) => {
    try {
      const pr = loadProject(opts.project);
      const res = validateProject(pr);
      console.log(`Project: ${pr.name}  (repo: ${pr.dir})\n`);
      console.log(formatEnforcement(res.enforcement));
      console.log("");
      for (const i of res.issues) console.log(`${i.level === "error" ? "ERROR" : "warn "}  ${i.message}`);
      if (opts.taskFile) {
        try {
          const t = readTaskFile(absPath(opts.taskFile, process.cwd()));
          console.log(`task file OK (${Buffer.byteLength(t)} bytes)`);
        } catch (e) {
          console.log(`ERROR  ${(e as Error).message}`);
          res.ok = false;
        }
      }
      console.log(res.ok ? "\nValid." : "\nInvalid.");
      process.exit(res.ok ? 0 : 1);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).stack ?? String(e));
    }
  });

/** Ask the runtime CLIs what they support: refuse to start when something the team needs is explicitly missing, warn when unknown. */
async function preflight(pr: ResolvedProject): Promise<void> {
  const r = await preflightRuntimes(pr);
  for (const w of r.warnings) console.error(`warn   ${w}`);
  if (r.errors.length) fail(`${r.errors.map((e) => `ERROR  ${e}`).join("\n")}\nFix the above (see \`agent-lyceum doctor\`).`);
}

/** Take the project's single-run lock, or exit with the reason. */
function takeLock(pr: ResolvedProject, runId: string): ProjectLease {
  try {
    return acquireProjectLock(pr.paths.root, runId);
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
  console.log(`\nRun ${summary.runId} ended: ${summary.endReason}, outcome: ${summary.outcome}, after ${summary.rounds} round(s). Logs: ${path.join(runDir, "log.jsonl")}`);
  if (summary.outcomeNote) console.log(`Note: ${summary.outcomeNote}`);
  if (summary.verification) console.log(`Verification (as reported by the lead, not checked by agent-lyceum): ${summary.verification}`);
  if (summary.doneMessage) {
    console.log(`\nLead's final message — ${summary.doneMessage.subject}\n\n${summary.doneMessage.body}`);
    console.log(`\nResult saved to: ${path.join(runDir, RESULT_FILE)}`);
  }
}

function reportRun(summary: RunSummary, runDir: string): never {
  printRun(summary, runDir);
  process.exit(exitCodeForOutcome(summary.outcome));
}

/** Take the lock and continue a run; the lock is released when it stops (also when it stops because it waits for answers). */
async function continueRun(pr: ResolvedProject, dir: string, runId: string): Promise<RunSummary> {
  const lease = takeLock(pr, runId);
  const cancel = cancelOnSignals();
  try {
    console.log(`Project ${pr.name} — repo ${pr.dir}`);
    const state = loadRunState(dir);
    console.log(`Resuming run ${state.run_id} (${state.end_reason ?? "interrupted"}) at round ${state.rounds}/${pr.dispatcher.max_rounds}: ${state.task_summary}`);
    // Read the state again under the lock: another process may have changed it while we were checking.
    return await runTeam({ project: pr, resume: state, runDir: dir, signal: cancel.signal });
  } finally {
    cancel.dispose();
    lease.release();
  }
}

const interactive = (): boolean => !!process.stdin.isTTY && !!process.stdout.isTTY;

function printWaiting(pr: ResolvedProject, runId: string, file: string, problems: string[]): void {
  console.log(`\nRun ${runId} is waiting for your answers.\n  File: ${file}`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log(`Answer with: agent-lyceum answer ${runId} -p ${pr.name}   (or edit the file, then: agent-lyceum resume ${runId} -p ${pr.name})`);
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
  .description('Start the dispatcher: give the task to the lead. Use "<task>" or --task-file <path>.')
  .option("-p, --project <name>")
  .option("--task-file <path>", "read the task from a file")
  .option("--assume-defaults", "when the run stops to ask, use the suggested answer for every question that has one")
  .action(async (task: string | undefined, opts: { project?: string; taskFile?: string; assumeDefaults?: boolean }) => {
    try {
      const pr = loadProject(opts.project);
      const res = validateProject(pr);
      for (const i of res.issues) console.error(`${i.level === "error" ? "ERROR" : "warn "}  ${i.message}`);
      if (!res.ok) fail("Configuration is invalid; fix the errors above (see `agent-lyceum validate`).");
      await preflight(pr);

      const runId = newRunId();
      const runDir = path.join(pr.paths.runs, runId);
      const lease = takeLock(pr, runId);
      let summary: RunSummary;
      const cancel = cancelOnSignals();
      try {
        const prepared = prepareTask({ text: task, file: opts.taskFile, cwd: process.cwd(), runDir });
        console.log(`Project ${pr.name} — repo ${pr.dir}`);
        console.log(`Task: ${prepared.source === "file" ? `file ${prepared.sourcePath}` : "text"} (${prepared.bytes} bytes${prepared.inline ? "" : ", passed by reference"})`);
        summary = await runTeam({ project: pr, task: prepared, runDir, signal: cancel.signal });
      } finally {
        cancel.dispose();
        lease.release();
      }
      await driveRun(pr, runDir, summary, !!opts.assumeDefaults);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });

program
  .command("resume [run-id]")
  .description("Continue an interrupted (or failed) run: same run dir, sessions and round count; the task is not re-sent. Without an id, picks the newest run that is not done or running; with an id, continues that run.")
  .option("-p, --project <name>")
  .option("--assume-defaults", "if the run waits for answers, use the suggested answer for every unanswered question that has one")
  .action(async (runId: string | undefined, opts: { project?: string; assumeDefaults?: boolean }) => {
    try {
      const pr = loadProject(opts.project);
      const res = validateProject(pr);
      for (const i of res.issues) console.error(`${i.level === "error" ? "ERROR" : "warn "}  ${i.message}`);
      if (!res.ok) fail("Configuration is invalid; fix the errors above (see `agent-lyceum validate`).");
      await preflight(pr);

      let found: ReturnType<typeof latestUnfinishedRun>;
      if (runId) {
        assertName("run", runId);
        const dir = path.join(pr.paths.runs, runId);
        if (!fs.existsSync(path.join(dir, "state.json"))) fail(`Run "${runId}" not found in ${pr.paths.runs}.`);
        found = { dir, state: loadRunState(dir) };
      } else {
        found = latestUnfinishedRun(pr);
        if (!found) fail("No unfinished run to resume. Start one with: agent-lyceum run \"<task>\"");
      }
      const { dir, state } = found!;
      if (!state.end_reason && runIsAlive(state, pr)) fail(`Run ${state.run_id} is still running (pid ${state.pid}).`);
      if (state.end_reason === "done") {
        const result = path.join(dir, RESULT_FILE);
        if (!fs.existsSync(result)) fail(`Run ${state.run_id} already finished (done); nothing to resume.`);
        const o = outcomeOf(state)!;
        console.log(`Run ${state.run_id} already finished (done); nothing to resume. Outcome: ${o.outcome}${o.verified ? "" : " (not verified: this run ended before outcomes were recorded)"}. Result: ${result}\n\n${fs.readFileSync(result, "utf8")}`);
        process.exit(exitCodeForOutcome(o.outcome));
      }
      if (state.rounds >= pr.dispatcher.max_rounds)
        fail(`Run ${state.run_id} used ${state.rounds}/${pr.dispatcher.max_rounds} rounds; raise dispatcher.max_rounds in project.yaml first.`);

      if (state.end_reason === "waiting") {
        const prep = prepareAnswers(dir, { assumeDefaults: !!opts.assumeDefaults });
        if (!prep.complete) {
          printWaiting(pr, state.run_id, prep.path, prep.problems);
          process.exit(3);
        }
      }
      const summary = await continueRun(pr, dir, state.run_id);
      await driveRun(pr, dir, summary, !!opts.assumeDefaults);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });

program
  .command("answer <run-id>")
  .description("Answer the questions a waiting run asked: opens ask-reply.md in $EDITOR, checks the answers, then continues the run. With --no-edit it only checks a file you already edited.")
  .option("-p, --project <name>")
  .option("--no-edit", "do not open the editor; check the file as it is")
  .option("--assume-defaults", "use the suggested answer for every unanswered question that has one")
  .action(async (runId: string, opts: { project?: string; edit: boolean; assumeDefaults?: boolean }) => {
    try {
      assertName("run", runId);
      const pr = loadProject(opts.project);
      const dir = path.join(pr.paths.runs, runId);
      if (!fs.existsSync(path.join(dir, "state.json"))) fail(`Run "${runId}" not found in ${pr.paths.runs}.`);
      const state = loadRunState(dir);
      if (state.end_reason !== "waiting") fail(`Run ${runId} is not waiting for answers (${state.end_reason ?? "not finished"}).`);
      if (opts.edit) openInEditor(prepareAnswers(dir, {}).path);
      const prep = prepareAnswers(dir, { assumeDefaults: !!opts.assumeDefaults });
      if (!prep.complete) {
        printWaiting(pr, runId, prep.path, prep.problems);
        process.exit(3);
      }
      const res = validateProject(pr);
      for (const i of res.issues) console.error(`${i.level === "error" ? "ERROR" : "warn "}  ${i.message}`);
      if (!res.ok) fail("Configuration is invalid; fix the errors above (see `agent-lyceum validate`).");
      await preflight(pr);
      const summary = await continueRun(pr, dir, runId);
      await driveRun(pr, dir, summary, !!opts.assumeDefaults);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });

/** Color when writing to a terminal, unless NO_COLOR is set; FORCE_COLOR overrides. */
program
  .command("clear <run-id>")
  .description(
    "Delete a task (run) by id: its run directory (state, log, result, mailboxes), its task memory and its agent worktrees, branches and snapshots. " +
      "Long-term (global and project) memory is never touched. Refuses while the run is running, or while a worktree holds work that is not in the repo.",
  )
  .option("-p, --project <name>")
  .option("--dry-run", "only list what would be deleted and what would be kept")
  .option("--keep-worktrees", "keep the agents' worktrees and branches (and their snapshots), and still clear the run and its task memory")
  .action((runId: string, opts: { project?: string; dryRun?: boolean; keepWorktrees?: boolean }) => {
    try {
      assertName("run", runId);
      const pr = loadProject(opts.project);
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
        const plan = planRunCleanup(pr, runId, { keepWorktrees: opts.keepWorktrees });
        console.log("Dry run: nothing is deleted.");
        showPlan(plan);
        if (plan.refusals.length) refuse(plan);
        return;
      }
      const lease = takeLock(pr, runId);
      try {
        const plan = planRunCleanup(pr, runId, { keepWorktrees: opts.keepWorktrees });
        if (plan.refusals.length) refuse(plan);
        showPlan(plan);
        const report = executeRunCleanup(plan);
        if (report.failed.length) {
          for (const f of report.failed) console.error(`FAILED  ${f.item.label}: ${f.error}`);
          fail("Cleanup stopped at the first failure; fix it and repeat the same command to finish.");
        }
        console.log(`Deleted run ${runId}: ${plan.summary.slice(runId.length + 2)}`);
      } finally {
        lease.release();
      }
    } catch (e) {
      fail((e as Error).message);
    }
  });

const configCmd = program.command("config").description("Inspect configuration");
configCmd
  .command("show")
  .description("Show the effective configuration of a project and where each value comes from")
  .requiredOption("--resolved", "merge global library, project file and defaults (currently the only view)")
  .option("-p, --project <name>")
  .option("--json", "print as JSON")
  .action((opts: { project?: string; json?: boolean }) => {
    try {
      const h = home();
      const pr = loadProject(opts.project);
      const { project, sources } = resolveProjectWithSources(h, pr.name);
      const values = flattenResolved(project);
      if (opts.json) {
        console.log(JSON.stringify({ schema_version: 1, project: project.name, values, sources }, null, 2));
        return;
      }
      const rel = (f: string) => path.relative(h, f) || f;
      const where = (s: SourceInfo): string => ("default" in s ? "default" : "inferred_from" in s ? `inferred from ${s.inferred_from.key} (${rel(s.inferred_from.file)})` : rel(s.file));
      const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
      const keys = Object.keys(sources).filter((k) => values[k] !== undefined);
      const w = Math.max(...keys.map((k) => `${k} = ${show(values[k])}`.length));
      for (const k of keys) console.log(`${`${k} = ${show(values[k])}`.padEnd(w)}   ${where(must(sources[k], `source of ${k}`))}`);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });

program
  .command("doctor")
  .description("Check the setup without running any agent: configuration, git, the project lock, and what each runtime CLI supports (from --version/--help).")
  .option("-p, --project <name>")
  .option("--json", "print the report as JSON")
  .action(async (opts: { project?: string; json?: boolean }) => {
    try {
      const report = await diagnoseProject(loadProject(opts.project));
      console.log(opts.json ? JSON.stringify({ schema_version: 1, ...report }, null, 2) : formatDoctor(report));
      process.exit(report.ok ? 0 : 1);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });

program
  .command("unlock")
  .description("Remove a project's run lock left behind by a crashed run. Shows the lock first; needs --force to remove it.")
  .option("-p, --project <name>")
  .option("--force", "remove the lock even though its owner cannot be confirmed dead")
  .action((opts: { project?: string; force?: boolean }) => {
    try {
      const pr = loadProject(opts.project);
      const info = inspectProjectLock(pr.paths.root);
      if (!info && !fs.existsSync(path.join(pr.paths.root, "lock.json"))) {
        console.log(`Project ${pr.name} has no run lock.`);
        return;
      }
      if (info) {
        console.log(`Lock held for run ${info.run_id} by pid ${info.pid} on ${info.hostname}, last heartbeat ${info.heartbeat_at}${lockHolderAlive(info) ? " (that process is still alive)" : " (that process is gone)"}.`);
      } else console.log("The lock file exists but cannot be read.");
      if (!opts.force) fail("Not removed. Check that no run is active, then repeat with --force.");
      forceUnlock(pr.paths.root);
      console.log("Lock removed. Resume the run with: agent-lyceum resume");
    } catch (e) {
      fail((e as Error).message);
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
        if (opts.taskId) assertName("run", opts.taskId);
        const report = opts.taskList ? buildTaskListReport(pr) : buildStatusReport(pr, opts.taskId);
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      if (opts.taskList) {
        console.log(formatTaskList(pr, useColor()));
        return;
      }
      if (opts.taskId) {
        assertName("run", opts.taskId);
        const dir = path.join(pr.paths.runs, opts.taskId);
        if (!fs.existsSync(path.join(dir, "state.json"))) fail(`Run "${opts.taskId}" not found in ${pr.paths.runs}. List ids with: agent-lyceum status --task-list`);
        console.log(formatRunDetail({ dir, state: loadRunState(dir) }, Date.now(), useColor(), pr));
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

program.parseAsync().catch((e) => fail((e as Error).message));


#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { Command } from "commander";
import { ConfigError, findProjectForCwd, listProjects, resolveProject, type ResolvedProject } from "./config.js";
import { newRunId, RESULT_FILE, runTeam, type RunSummary } from "./dispatcher.js";
import { absPath, assertName, projectPaths, resolveHome } from "./paths.js";
import { addProject, initHome, removeProject } from "./scaffold.js";
import { formatMonitor, formatRunDetail, formatStatusWithLog, formatTaskList, latestUnfinishedRun, runIsAlive } from "./status.js";
import { prepareTask, readTaskFile } from "./task.js";
import { formatEnforcement, validateProject } from "./validate.js";

const program = new Command();
program
  .name("agent-team")
  .description("Configure and run a team of Claude Code / Codex agents with scoped context and file mailboxes.")
  .option("--home <dir>", "agent-team home (default: $AGENT_TEAM_HOME or ~/agent-team-config)");

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
            : `No projects registered. Use: agent-team project add <name> --dir <repo>`),
      );
    }
  }
  if (!fs.existsSync(projectPaths(h, name).config)) fail(`Project "${name}" is not registered in ${h}.`);
  return resolveProject(h, name);
}

program
  .command("init")
  .description("Create the agent-team home with a global agent library")
  .option("-y, --yes", "do not ask for confirmation of the home path")
  .action(async (opts: { yes?: boolean }) => {
    const h = home();
    const explicit = program.opts().home || process.env.AGENT_TEAM_HOME;
    if (!opts.yes && !explicit && !fs.existsSync(h) && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await rl.question(`Create agent-team home at ${h}? [Y/n] `)).trim().toLowerCase();
      rl.close();
      if (ans === "n" || ans === "no") fail("Aborted. Set AGENT_TEAM_HOME or pass --home to choose another location.");
    }
    const r = initHome(h);
    console.log(`Home: ${r.home}`);
    for (const f of r.created) console.log(`  created  ${path.relative(h, f)}`);
    for (const f of r.skipped) console.log(`  kept     ${path.relative(h, f)}`);
    console.log(`\nNext: agent-team project add <name> --dir <your-repo>`);
  });

const project = program.command("project").description("Manage registered projects");
project
  .command("add <name>")
  .description("Register a project (config and context live in the home, not in the repo)")
  .requiredOption("--dir <repo>", "the repo agents will work in")
  .action((name: string, opts: { dir: string }) => {
    try {
      const r = addProject(home(), name, opts.dir);
      console.log(`Project "${name}" created: ${r.config}\nEdit it, then run: agent-team validate --project ${name}`);
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

function reportRun(summary: RunSummary, runDir: string): never {
  console.log(`\nRun ${summary.runId} ended: ${summary.endReason} after ${summary.rounds} round(s). Logs: ${runDir}`);
  if (summary.doneMessage) {
    console.log(`\nLead's final message — ${summary.doneMessage.subject}\n\n${summary.doneMessage.body}`);
    console.log(`\nResult saved to: ${path.join(runDir, RESULT_FILE)}`);
  }
  if (summary.endReason === "idle") console.log("Note: all mailboxes were empty but the lead never sent a \"done\" message.");
  process.exit(summary.endReason === "done" || summary.endReason === "idle" ? 0 : 2);
}

program
  .command("run [task]")
  .description('Start the dispatcher: give the task to the lead. Use "<task>" or --task-file <path>.')
  .option("-p, --project <name>")
  .option("--task-file <path>", "read the task from a file")
  .action(async (task: string | undefined, opts: { project?: string; taskFile?: string }) => {
    try {
      const pr = loadProject(opts.project);
      const res = validateProject(pr);
      for (const i of res.issues) console.error(`${i.level === "error" ? "ERROR" : "warn "}  ${i.message}`);
      if (!res.ok) fail("Configuration is invalid; fix the errors above (see `agent-team validate`).");

      const runDir = path.join(pr.paths.runs, newRunId());
      const prepared = prepareTask({ text: task, file: opts.taskFile, cwd: process.cwd(), runDir });
      console.log(`Project ${pr.name} — repo ${pr.dir}`);
      console.log(`Task: ${prepared.source === "file" ? `file ${prepared.sourcePath}` : "text"} (${prepared.bytes} bytes${prepared.inline ? "" : ", passed by reference"})`);

      reportRun(await runTeam({ project: pr, task: prepared, runDir }), runDir);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });

program
  .command("resume [run-id]")
  .description("Continue an interrupted (or failed) run: same run dir, sessions and round count; the task is not re-sent. Without an id, picks the newest run that is not done or running; with an id, continues that run.")
  .option("-p, --project <name>")
  .action(async (runId: string | undefined, opts: { project?: string }) => {
    try {
      const pr = loadProject(opts.project);
      const res = validateProject(pr);
      for (const i of res.issues) console.error(`${i.level === "error" ? "ERROR" : "warn "}  ${i.message}`);
      if (!res.ok) fail("Configuration is invalid; fix the errors above (see `agent-team validate`).");

      let found: ReturnType<typeof latestUnfinishedRun>;
      if (runId) {
        assertName("run", runId);
        const dir = path.join(pr.paths.runs, runId);
        const f = path.join(dir, "state.json");
        if (!fs.existsSync(f)) fail(`Run "${runId}" not found in ${pr.paths.runs}.`);
        found = { dir, state: JSON.parse(fs.readFileSync(f, "utf8")) };
      } else {
        found = latestUnfinishedRun(pr);
        if (!found) fail("No unfinished run to resume. Start one with: agent-team run \"<task>\"");
      }
      const { dir, state } = found!;
      if (!state.end_reason && runIsAlive(state)) fail(`Run ${state.run_id} is still running (pid ${state.pid}).`);
      if (state.end_reason === "done") {
        const result = path.join(dir, RESULT_FILE);
        if (!fs.existsSync(result)) fail(`Run ${state.run_id} already finished (done); nothing to resume.`);
        console.log(`Run ${state.run_id} already finished (done); nothing to resume. Result: ${result}\n\n${fs.readFileSync(result, "utf8")}`);
        process.exit(0);
      }
      if (state.rounds >= pr.dispatcher.max_rounds)
        fail(`Run ${state.run_id} used ${state.rounds}/${pr.dispatcher.max_rounds} rounds; raise dispatcher.max_rounds in project.yaml first.`);

      console.log(`Project ${pr.name} — repo ${pr.dir}`);
      console.log(`Resuming run ${state.run_id} (${state.end_reason ?? "interrupted"}) at round ${state.rounds}/${pr.dispatcher.max_rounds}: ${state.task_summary}`);
      reportRun(await runTeam({ project: pr, resume: state, runDir: dir }), dir);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });

/** Color when writing to a terminal, unless NO_COLOR is set; FORCE_COLOR overrides. */
program
  .command("clear <run-id>")
  .description("Delete a task (run) by id: removes its run directory (state, log, result, snapshots). Refuses if it is still running.")
  .option("-p, --project <name>")
  .action((runId: string, opts: { project?: string }) => {
    try {
      assertName("run", runId);
      const pr = loadProject(opts.project);
      const dir = path.join(pr.paths.runs, runId);
      const f = path.join(dir, "state.json");
      if (!fs.existsSync(f)) fail(`Run "${runId}" not found in ${pr.paths.runs}. List ids with: agent-team status --task-list`);
      const state = JSON.parse(fs.readFileSync(f, "utf8"));
      if (!state.end_reason && runIsAlive(state)) fail(`Run ${runId} is still running (pid ${state.pid}); not deleting it.`);
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`Deleted run ${runId}: ${state.task_summary ?? ""}`);
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
  .action(async (opts: { project?: string; taskList?: string | boolean; taskId?: string; monitor?: boolean; interval: string }) => {
    try {
      const pr = loadProject(typeof opts.taskList === "string" ? opts.taskList : opts.project);
      if (opts.taskList) {
        console.log(formatTaskList(pr, useColor()));
        return;
      }
      if (opts.taskId) {
        assertName("run", opts.taskId);
        const dir = path.join(pr.paths.runs, opts.taskId);
        const f = path.join(dir, "state.json");
        if (!fs.existsSync(f)) fail(`Run "${opts.taskId}" not found in ${pr.paths.runs}. List ids with: agent-team status --task-list`);
        console.log(formatRunDetail({ dir, state: JSON.parse(fs.readFileSync(f, "utf8")) }, Date.now(), useColor()));
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


import fs from "node:fs";
import path from "node:path";
import type { WakeInput, WakeResult } from "../src/adapters/index.js";
import type { ResolvedProject } from "../src/config.js";
import { runTeam, type RunSummary } from "../src/dispatcher.js";
import type { RunOptions } from "../src/run-session.js";
import { inboxDir, outboxDir } from "../src/policy.js";
import { loadRunState, bindRunProject } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { FULL_DONE, initGitRepo, makeEnv, withSections, write, type TestEnv } from "./helpers.js";

// Shared driver for the same-role instance tests (spec 23.15): a fake invoker over a real scratch git repo, a script per wake-up,
// and a way to stop a run and resume it with the same script.

export const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
export const rateLimited: WakeResult = { ok: false, text: "", exitCode: 1, timedOut: false, error: "API Error: 429", kind: "rate_limit" };

export interface Wake {
  /** Agent being woken (an instance is `fe-member--2`). */
  agent: string;
  /** How many times this agent was woken so far in the test, this wake included (kept across a resume). */
  n: number;
  i: WakeInput;
  /** The directory the agent works in (its own worktree). */
  dir: string;
}
export type Script = (w: Wake, world: World) => WakeResult | undefined | Promise<WakeResult | undefined>;

export interface World {
  env: TestEnv;
  project: ResolvedProject;
  runDir: string;
  calls: Record<string, number>;
  /** The lead's worktree, once it was woken. */
  leadDir: string;
  /** Every user prompt each agent was woken with. */
  prompts: Record<string, string[]>;
  /** Directories each agent was woken in, in order. */
  dirs: Record<string, string[]>;
  lines: string[];
  /** Free for a script's own bookkeeping. */
  notes: Record<string, unknown>;
}

export function newWorld(configure: (p: ResolvedProject, env: TestEnv) => void = () => {}): World {
  const env = makeEnv();
  initGitRepo(env.repo);
  const project = env.project();
  configure(project, env);
  return { env, project, runDir: path.join(project.paths.runs, "run-1"), calls: {}, leadDir: "", prompts: {}, dirs: {}, lines: [], notes: {} };
}

function invokerOf(world: World, script: Script) {
  return async (i: WakeInput): Promise<WakeResult> => {
    const agent = i.agent.name;
    const n = (world.calls[agent] ?? 0) + 1;
    world.calls[agent] = n;
    const dir = i.workspace?.dir ?? "";
    if (agent === "lead") world.leadDir = dir;
    world.prompts[agent] = [...(world.prompts[agent] ?? []), i.userPrompt];
    world.dirs[agent] = [...(world.dirs[agent] ?? []), dir];
    return (await script({ agent, n, i, dir }, world)) ?? OK;
  };
}

export function run(world: World, script: Script, extra: Partial<RunOptions> = {}): Promise<RunSummary> {
  return runTeam({
    project: world.project,
    task: prepareTask({ text: "build it", cwd: world.env.root, runDir: world.runDir }),
    runDir: world.runDir,
    log: (l) => world.lines.push(l),
    invoker: invokerOf(world, script),
    ...extra,
  });
}

export function resume(world: World, script: Script, extra: Partial<RunOptions> = {}): Promise<RunSummary> {
  return runTeam({
    project: extra.project ?? world.project,
    resume: loadRunState(world.runDir),
    runDir: world.runDir,
    log: (l) => world.lines.push(l),
    invoker: invokerOf(world, script),
    ...extra,
  });
}

let counter = 0;
/** Write a mail into the sender's outbox. `extra` is raw frontmatter lines (`parallel: true\n`, `reply_to: abc\n`). */
export function send(i: WakeInput, to: string, subject: string, type = "task", extra = ""): void {
  write(
    path.join(outboxDir(i.project, i.agent.name), `${String(++counter).padStart(4, "0")}-${subject.replace(/\W+/g, "-")}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}${extra}---\n\n${type === "done" ? FULL_DONE : withSections(type, `body of ${subject}`)}\n`,
  );
}

/** The id of the message in a wake-up prompt whose block matches `re`. */
export function idIn(prompt: string, re: RegExp): string | undefined {
  for (const seg of prompt.split(/\n(?=id: )/)) if (re.test(seg)) return /^id: (\S+)/.exec(seg)?.[1];
  return undefined;
}

export const allPrompts = (world: World, agent: string): string => (world.prompts[agent] ?? []).join("\n=====\n");

/** Subjects of the mail currently or formerly in a folder. */
export function subjectsIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => /^subject: (.*)$/m.exec(fs.readFileSync(path.join(dir, f), "utf8"))?.[1] ?? "?");
}

export const boundOf = (world: World) => bindRunProject(world.project, world.runDir, "run", loadRunState(world.runDir).instances);
export const inboxOf = (world: World, agent: string) => inboxDir(boundOf(world), agent);
export const pendingOf = (world: World, role: string) => path.join(inboxOf(world, role), "pending");

export function logEvents(world: World, event: string): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(world.runDir, "log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.event === event);
}

export function journal(world: World): Record<string, unknown>[] {
  if (!fs.existsSync(path.join(world.runDir, "mail", "journal.jsonl"))) return [];
  return fs
    .readFileSync(path.join(world.runDir, "mail", "journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>]; // a line cut short by a crash is skipped, as the dispatcher does
      } catch {
        return [];
      }
    });
}

/** Every file below a directory, relative, with its bytes (for "nothing was written" checks). */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = `${fs.statSync(p).mtimeMs}:${fs.readFileSync(p, "utf8")}`;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/**
 * A barrier that releases `count` concurrent wake-ups together, the moment the last one arrives (no polling). `ms` only bounds a hang when
 * they never overlap. `max` is the most that were ever waiting at once.
 */
export function overlap(count: number, ms = 5000) {
  let arrived = 0;
  let max = 0;
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  return {
    max: () => max,
    async hold(): Promise<void> {
      arrived++;
      max = Math.max(max, arrived);
      if (arrived >= count) return release();
      const timer = setTimeout(release, ms);
      await released;
      clearTimeout(timer);
    },
  };
}

export { initGitRepo };

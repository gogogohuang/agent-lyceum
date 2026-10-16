import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeMemoryEnv, write, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");

/** Run ids sort oldest to newest in this order, so a home built up to run N has run N as its current run. */
export const GOLDEN_RUNS = ["20260101-000000", "20260102-000000", "20260103-000000", "20260104-000000"] as const;
export const GOLDEN_KINDS = ["legacy", "done", "waiting", "failed"] as const;
export type GoldenKind = (typeof GOLDEN_KINDS)[number];

/** A pid above the pid limit of macOS and Linux: never alive. */
const DEAD_PID = 2147483646;

function runState(kind: GoldenKind, i: number): Record<string, unknown> {
  const id = GOLDEN_RUNS[i]!;
  const day = `2026-01-0${i + 1}`;
  const wake = { at: `${day}T00:00:30Z`, ok: true };
  if (kind === "legacy") {
    // A state written before names, outcomes and the optional fields existed.
    return { run_id: id, rounds: 2, max_rounds: 10, last_wake: { lead: wake }, wakes: [], end_reason: "idle", task_summary: "Old task", pid: DEAD_PID };
  }
  const base = {
    schema_version: 2,
    mail_layout: "run",
    run_id: id,
    name: `${kind}-run`,
    project: "demo",
    task_source: "text",
    started_at: `${day}T00:00:00Z`,
    ended_at: `${day}T00:05:00Z`,
    rounds: 3,
    max_rounds: 10,
    sessions: { lead: "sess-lead" },
    output_tokens: 1234,
    last_wake: { lead: wake },
    wakes: [{ agent: "lead", round: 1, at: `${day}T00:00:10Z`, ok: true }],
    pid: DEAD_PID,
    task_summary: `A ${kind} task`,
    steps: [{ text: "design", done: true }, { text: "build", done: kind === "done" }],
  };
  if (kind === "done") return { ...base, end_reason: "done", outcome: "completed", verification: "npm test: passed" };
  if (kind === "waiting") return { ...base, ended_at: undefined, end_reason: "waiting", outcome: "waiting" };
  return { ...base, end_reason: "lead_failed", outcome: "failed", outcome_note: "the lead's wake failed", last_wake: { lead: { at: wake.at, ok: false, error: "boom" } } };
}

/** A temp home with a project whose lead has a large memory index, and the first `count` golden runs. */
export function buildGoldenEnv(count: number): TestEnv {
  const env = makeMemoryEnv();
  write(path.join(env.project().agents.lead!.memory.project!, "MEMORY.md"), "- entry\n".repeat(800));
  const runs = env.project().paths.runs;
  GOLDEN_KINDS.slice(0, count).forEach((kind, i) => {
    write(path.join(runs, GOLDEN_RUNS[i]!, "state.json"), JSON.stringify(runState(kind, i)));
    if (kind === "done") write(path.join(runs, GOLDEN_RUNS[i]!, "result.md"), "# Done\n\nall good\n");
  });
  return env;
}

/** stdout of `agent-lyceum --home <home> status <args>`, with the temp root replaced by `<ROOT>` and nothing else changed. */
export function statusOutput(env: TestEnv, args: string[]): string {
  const r = spawnSync(process.execPath, ["--import", "tsx", cli, "--home", env.home, "status", "-p", "demo", ...args], { encoding: "utf8", cwd: path.join(here, ".."), env: { ...process.env, NO_COLOR: "1" } });
  if (r.status !== 0) throw new Error(`status ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  const real = fs.realpathSync(env.root);
  return r.stdout.split(real).join("<ROOT>").split(env.root).join("<ROOT>");
}

/** The captures: file name -> how many runs the home holds and the status arguments. */
export function goldenCases(): { file: string; count: number; args: string[] }[] {
  return [
    ...GOLDEN_KINDS.map((k, i) => ({ file: `status-${k}.json`, count: i + 1, args: ["--json"] })),
    { file: "task-list.json", count: 4, args: ["--task-list", "--json"] },
    ...GOLDEN_KINDS.map((k, i) => ({ file: `task-id-${k}.json`, count: 4, args: ["--task-id", GOLDEN_RUNS[i]!, "--json"] })),
  ];
}

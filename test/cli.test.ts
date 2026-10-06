import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, write, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");

let env: TestEnv;
afterEach(() => env?.cleanup());

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8", env: { ...process.env, ...extraEnv } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const ANSI = /\x1b\[/;

function seedRuns() {
  const runs = env.project().paths.runs;
  write(
    path.join(runs, "20260102-000000", "state.json"),
    JSON.stringify({
      run_id: "20260102-000000", rounds: 3, max_rounds: 10, last_wake: { lead: { at: "2026-01-02T00:00:00Z", ok: true } }, wakes: [],
      end_reason: "done", outcome: "completed", task_summary: "Ship it", sessions: { lead: "sess-SECRET-123" },
      steps: [{ text: "a", done: true }],
    }),
  );
  write(path.join(runs, "20260102-000000", "result.md"), "# Ship it\n\nall good\n");
  write(path.join(runs, "20260101-000000", "state.json"), JSON.stringify({ run_id: "20260101-000000", rounds: 1, max_rounds: 10, last_wake: {}, wakes: [], end_reason: "idle", task_summary: "Old" }));
}

describe("status --json", () => {
  it("prints only JSON on stdout, never ANSI colour, even when colour is forced", () => {
    env = makeEnv();
    seedRuns();
    const r = run(["status", "-p", "demo", "--json"], { FORCE_COLOR: "1" });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(ANSI);
    const j = JSON.parse(r.out);
    expect(j.schema_version).toBe(1);
    expect(j.project).toMatchObject({ name: "demo", lead: "lead" });
    expect(j.agents.map((a: any) => a.name)).toEqual(["lead", "fe-member", "qa-member"]);
    expect(j.run).toMatchObject({ run_id: "20260102-000000", state: "ended", end_reason: "done", outcome: "completed", outcome_verified: true, rounds: 3 });
    expect(r.out).not.toContain("sess-SECRET-123"); // session ids are not part of the report
  });

  it("works with no run yet", () => {
    env = makeEnv();
    const j = JSON.parse(run(["status", "-p", "demo", "--json"]).out);
    expect(j.run).toBeUndefined();
    expect(j.agents).toHaveLength(3);
  });

  it("--task-list and --task-id give the same facts as JSON", () => {
    env = makeEnv();
    seedRuns();
    const list = JSON.parse(run(["status", "-p", "demo", "--task-list", "--json"], { FORCE_COLOR: "1" }).out);
    expect(list.schema_version).toBe(1);
    expect(list.runs.map((x: any) => x.run_id)).toEqual(["20260102-000000", "20260101-000000"]);
    expect(list.runs[1]).toMatchObject({ outcome: "partial", outcome_verified: false, end_reason: "idle" }); // old run: not a checked result

    const one = run(["status", "-p", "demo", "--task-id", "20260101-000000", "--json"]);
    expect(one.code).toBe(0);
    expect(one.out).not.toMatch(ANSI);
    expect(JSON.parse(one.out).run.run_id).toBe("20260101-000000");
  });

  it("the text page and the JSON are made from the same report", () => {
    env = makeEnv();
    seedRuns();
    const text = run(["status", "-p", "demo"]).out;
    const j = JSON.parse(run(["status", "-p", "demo", "--json"]).out);
    expect(text).toContain(j.run.run_id);
    expect(text).toContain(`第 ${j.run.rounds}/${j.run.max_rounds} 輪`);
    const list = run(["status", "-p", "demo", "--task-list"]).out;
    const jl = JSON.parse(run(["status", "-p", "demo", "--task-list", "--json"]).out);
    for (const x of jl.runs) expect(list).toContain(x.run_id);
  });

  it("reports errors on stderr with a non-zero exit and nothing on stdout", () => {
    env = makeEnv();
    const unknownRun = run(["status", "-p", "demo", "--task-id", "nope", "--json"]);
    expect(unknownRun.code).not.toBe(0);
    expect(unknownRun.out).toBe("");
    expect(unknownRun.err).toMatch(/not found/);
    const unknownProject = run(["status", "-p", "ghost", "--json"]);
    expect(unknownProject.code).not.toBe(0);
    expect(unknownProject.out).toBe("");
    expect(unknownProject.err).toMatch(/ghost/);
  });
});

describe("config show --resolved", () => {
  it("lists every effective value with where it came from", () => {
    env = makeEnv();
    const r = run(["config", "show", "--resolved", "-p", "demo"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/agents\.lead\.runtime\s*=\s*claude-code\s+team\.yaml/);
    expect(r.out).toMatch(/dispatcher\.max_parallel\s*=\s*1\s+projects\/demo\/project\.yaml/);
  });

  it("--json is machine readable", () => {
    env = makeEnv();
    const r = run(["config", "show", "--resolved", "-p", "demo", "--json"], { FORCE_COLOR: "1" });
    const j = JSON.parse(r.out);
    expect(r.out).not.toMatch(ANSI);
    expect(j.schema_version).toBe(1);
    expect(j.values["agents.lead.runtime"]).toBe("claude-code");
    expect(j.sources["agents.lead.runtime"]).toEqual({ file: path.join(env.home, "team.yaml"), key: "agents.lead.runtime" });
  });

  it("fails on stderr for an unknown project", () => {
    env = makeEnv();
    const r = run(["config", "show", "--resolved", "-p", "ghost", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
  });
});

describe("doctor --json", () => {
  it("prints JSON only", () => {
    env = makeEnv();
    const r = run(["doctor", "-p", "demo", "--json"], { FORCE_COLOR: "1" });
    expect(r.out).not.toMatch(ANSI);
    const j = JSON.parse(r.out);
    expect(j.schema_version).toBe(1);
    expect(Array.isArray(j.checks)).toBe(true);
  });
});

void fs;

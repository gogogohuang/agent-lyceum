import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, write, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

let env: TestEnv;
afterEach(() => env?.cleanup());

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8", env: { ...process.env, ...extraEnv } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[`);

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

describe("status --json", { timeout: 30_000 }, () => {
  it("prints only JSON on stdout, never ANSI colour, even when colour is forced", () => {
    env = makeEnv();
    seedRuns();
    const r = run(["status", "-p", "demo", "--json"], { FORCE_COLOR: "1" });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(ANSI);
    const j = JSON.parse(r.out);
    expect(j.schema_version).toBe(1);
    expect(j.project).toMatchObject({ name: "demo", lead: "lead" });
    expect(j.agents.map((a) => a.name)).toEqual(["lead", "fe-member", "qa-member"]);
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
    expect(list.runs.map((x) => x.run_id)).toEqual(["20260102-000000", "20260101-000000"]);
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

function seedNamed() {
  const runs = env.project().paths.runs;
  const seed = (id: string, name: string | undefined, summary: string) =>
    write(
      path.join(runs, id, "state.json"),
      JSON.stringify({ run_id: id, ...(name ? { name } : {}), rounds: 1, max_rounds: 10, last_wake: {}, wakes: [], end_reason: "idle", task_summary: summary }),
    );
  seed("20261014-010000", "login", "Add login");
  seed("20261014-020000", "login-2", "Add login again");
  seed("20261013-010000", undefined, "An old run without a name");
}

describe("runs found by id, name or unique prefix", { timeout: 30_000 }, () => {
  it("status --task-id, status --json --task-id and clear --dry-run accept a full id, a name and a unique prefix", () => {
    env = makeEnv();
    seedNamed();
    for (const q of ["20261014-010000", "login", "20261014-01"]) {
      const text = run(["status", "-p", "demo", "--task-id", q]);
      expect(text.code, q).toBe(0);
      expect(text.out).toContain("Add login");
      const j = JSON.parse(run(["status", "-p", "demo", "--task-id", q, "--json"]).out);
      expect(j.run).toMatchObject({ run_id: "20261014-010000", name: "login" });
      const dry = run(["clear", q, "-p", "demo", "--dry-run"]);
      expect(dry.code, q).toBe(0);
      expect(dry.out).toContain("20261014-010000");
    }
  });

  it("shows `name (run_id)` in the default status header, the --task-id header and clear output; a run without a name shows just its id", () => {
    env = makeEnv();
    seedNamed();
    expect(run(["status", "-p", "demo"]).out).toContain("login-2 (20261014-020000)");
    expect(run(["status", "-p", "demo", "--task-id", "login"]).out).toContain("執行 login (20261014-010000)");
    expect(run(["status", "-p", "demo", "--task-id", "20261013-010000"]).out).toContain("執行 20261013-010000 ");
    expect(run(["clear", "login", "-p", "demo", "--dry-run"]).out).toContain("Run login (20261014-010000)");
    const del = run(["clear", "login", "-p", "demo"]);
    expect(del.out).toContain("Deleted run login (20261014-010000):");
    const old = run(["clear", "20261013-010000", "-p", "demo"]);
    expect(old.out).toContain("Deleted run 20261013-010000:");
  });

  it("an exact name wins over a longer name that starts with it", () => {
    env = makeEnv();
    seedNamed();
    expect(JSON.parse(run(["status", "-p", "demo", "--task-id", "login", "--json"]).out).run.run_id).toBe("20261014-010000");
    expect(JSON.parse(run(["status", "-p", "demo", "--task-id", "login-2", "--json"]).out).run.run_id).toBe("20261014-020000");
  });

  it("an old run without a name still works by its id", () => {
    env = makeEnv();
    seedNamed();
    const r = run(["clear", "20261013-010000", "-p", "demo", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("20261013-010000");
    expect(JSON.parse(run(["status", "-p", "demo", "--task-id", "20261013-010000", "--json"]).out).run.name).toBeUndefined();
  });

  it("an ambiguous prefix lists the candidates (name, id, task) and exits 1; nothing is deleted", () => {
    env = makeEnv();
    seedNamed();
    for (const args of [["clear", "2026101", "-p", "demo"], ["status", "-p", "demo", "--task-id", "2026101"], ["resume", "2026101", "-p", "demo"]]) {
      const r = run(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toContain("matches several runs");
      for (const x of ["login ", "login-2", "20261014-010000", "20261014-020000", "Add login", "Add login again"]) expect(r.err).toContain(x);
    }
    expect(fs.existsSync(path.join(env.project().paths.runs, "20261014-010000", "state.json"))).toBe(true);
  });

  it("an unknown or empty query fails cleanly", () => {
    env = makeEnv();
    seedNamed();
    expect(run(["clear", "nope", "-p", "demo", "--dry-run"])).toMatchObject({ code: 1, err: expect.stringMatching(/not found/) });
    expect(run(["resume", "nope", "-p", "demo"])).toMatchObject({ code: 1, err: expect.stringMatching(/not found/) });
    const empty = run(["status", "-p", "demo", "--task-id", ""]);
    expect(empty.code).toBe(1);
    expect(empty.err).toMatch(/run id or name/);
    expect(run(["resume", "", "-p", "demo"]).code).not.toBe(0);
  });

  it("resume finds a run by name", () => {
    env = makeEnv();
    seedNamed();
    write(path.join(env.project().paths.runs, "20261014-010000", "state.json"), JSON.stringify({ run_id: "20261014-010000", name: "login", rounds: 1, max_rounds: 10, last_wake: {}, wakes: [], end_reason: "done", outcome: "completed", task_summary: "Add login" }));
    write(path.join(env.project().paths.runs, "20261014-010000", "result.md"), "# Done\n");
    // `resume` checks the runtime CLI before it reads the run, so give it a stand-in `claude` (CI has none installed).
    const bin = path.join(env.root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
    const r = run(["resume", "login", "-p", "demo"], { PATH: `${bin}:${process.env.PATH}` });
    expect(r.out).toContain("Run login (20261014-010000) already finished (done)");
  });

  it("the task list shows names, and leaves the column out when no run has one", () => {
    env = makeEnv();
    seedNamed();
    const out = run(["status", "-p", "demo", "--task-list"]).out;
    expect(out).toMatch(/login-2\s+20261014-020000/);
    expect(JSON.parse(run(["status", "-p", "demo", "--task-list", "--json"]).out).runs.map((x) => x.name)).toEqual(["login-2", "login", undefined]);
    env.cleanup();
    env = makeEnv();
    seedRuns();
    expect(run(["status", "-p", "demo", "--task-list"]).out).not.toContain("名稱");
  });
});

describe("doctor --resolved", { timeout: 30_000 }, () => {
  it("lists every effective value with where it came from", () => {
    env = makeEnv();
    const r = run(["doctor", "--resolved", "-p", "demo"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/agents\.lead\.runtime\s*=\s*claude-code\s+team\.yaml/);
    expect(r.out).toMatch(/dispatcher\.retry\s*=\s*2\s+projects\/demo\/project\.yaml/);
  });

  it("--json is machine readable", () => {
    env = makeEnv();
    const r = run(["doctor", "--resolved", "-p", "demo", "--json"], { FORCE_COLOR: "1" });
    const j = JSON.parse(r.out);
    expect(r.out).not.toMatch(ANSI);
    expect(j.schema_version).toBe(1);
    expect(j.values["agents.lead.runtime"]).toBe("claude-code");
    expect(j.sources["agents.lead.runtime"]).toEqual({ file: path.join(env.home, "team.yaml"), key: "agents.lead.runtime" });
  });

  it("fails on stderr for an unknown project", () => {
    env = makeEnv();
    const r = run(["doctor", "--resolved", "-p", "ghost", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
  });
});

describe("doctor --json", { timeout: 30_000 }, () => {
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

describe("status --json --watch", { timeout: 30_000 }, () => {
  it("needs --json and rejects --monitor / --task-list", () => {
    env = makeEnv();
    expect(run(["status", "-p", "demo", "--watch"]).err).toContain("--watch needs --json");
    expect(run(["status", "-p", "demo", "--json", "--watch", "--task-list"]).err).toContain("cannot be combined");
  });

  it("prints a frame at start and another when a run starts, without polling", async () => {
    env = makeEnv();
    const { spawn } = await import("node:child_process");
    const child = spawn(tsx, [cli, "--home", env.home, "status", "-p", "demo", "--json", "--watch", "--heartbeat", "60"], { stdio: ["pipe", "pipe", "pipe"] });
    const lines: string[] = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      lines.push(...parts.filter(Boolean));
    });
    const until = async (n: number) => {
      for (let i = 0; i < 400 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 50));
      expect(lines.length).toBeGreaterThanOrEqual(n);
    };
    try {
      await until(1);
      expect(JSON.parse(lines[0]).runs).toEqual({});
      // The heartbeat is 60s, so only the file watcher can produce the second frame.
      write(path.join(env.project().paths.runs, "20260101-000000", "state.json"), JSON.stringify({ run_id: "20260101-000000", rounds: 1, max_rounds: 10, last_wake: {}, wakes: [], pid: process.pid }));
      await until(2);
      expect(Object.keys(JSON.parse(lines[1]).runs)).toEqual(["20260101-000000"]);
    } finally {
      child.kill();
    }
  }, 30000); // tsx starts slowly on a loaded CI runner
});

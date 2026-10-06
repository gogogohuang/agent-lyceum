import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProjectLock } from "../src/project-lock.js";
import { executeRunCleanup, planRunCleanup } from "../src/run-cleanup.js";
import { newRunState, saveRunState } from "../src/run-store.js";
import { collectAgentChanges, integrateAgentChanges, prepareAgentWorkspace, snapshotBase } from "../src/worktree.js";
import { git, initGitRepo, makeEnv, makeParallel, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
const extra: string[] = [];
afterEach(() => {
  env?.cleanup();
  for (const d of extra.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A finished run with task memory; `id` doubles as its directory name. */
function makeRun(id: string, endReason: "idle" | "done" = "idle") {
  const p = env.project();
  const runDir = path.join(p.paths.runs, id);
  fs.mkdirSync(runDir, { recursive: true });
  saveRunState(runDir, { ...newRunState({ run_id: id, project: "demo", max_rounds: 5, task_summary: "t" }), end_reason: endReason });
  write(path.join(runDir, "log.jsonl"), "{}\n");
  write(path.join(p.paths.taskMemory, id, "lead", "MEMORY.md"), `notes of ${id}\n`);
  return runDir;
}
const exists = (...parts: string[]) => fs.existsSync(path.join(...parts));

function gitEnv() {
  env = makeEnv();
  initGitRepo(env.repo);
  makeParallel(env);
  return env.project();
}

describe("clear: what is deleted", () => {
  it("removes the run and its task memory, and nothing else", () => {
    env = makeEnv();
    const p = env.project();
    const a = makeRun("run-a");
    makeRun("run-b");
    write(path.join(env.home, "agents/lead/memory/MEMORY.md"), "global memory\n");
    write(path.join(p.paths.root, "agents/lead/memory/MEMORY.md"), "project memory\n");

    const plan = planRunCleanup(p, "run-a");
    expect(plan.refusals).toEqual([]);
    expect(plan.items.map((i) => i.kind)).toEqual(["task-memory", "run"]);
    const report = executeRunCleanup(plan);
    expect(report.failed).toEqual([]);

    expect(fs.existsSync(a)).toBe(false);
    expect(exists(p.paths.taskMemory, "run-a")).toBe(false);
    expect(exists(p.paths.runs, "run-b", "state.json")).toBe(true);
    expect(exists(p.paths.taskMemory, "run-b", "lead", "MEMORY.md")).toBe(true);
    expect(exists(env.home, "agents/lead/memory/MEMORY.md")).toBe(true);
    expect(exists(p.paths.root, "agents/lead/memory/MEMORY.md")).toBe(true);
    expect(fs.existsSync(path.join(p.paths.root, "cleanup"))).toBe(false); // the progress journal is gone too
  });

  it("only previews with a plan: planning deletes nothing", () => {
    env = makeEnv();
    const p = env.project();
    const a = makeRun("run-a");
    planRunCleanup(p, "run-a");
    expect(fs.existsSync(a)).toBe(true);
    expect(exists(p.paths.taskMemory, "run-a", "lead", "MEMORY.md")).toBe(true);
  });

  it("refuses a run that is still running, and an unknown run", () => {
    env = makeEnv();
    const p = env.project();
    const dir = makeRun("run-a");
    saveRunState(dir, { ...newRunState({ run_id: "run-a", project: "demo", max_rounds: 5 }) }); // no end reason
    const lease = acquireProjectLock(p.paths.root, "run-a");
    try {
      expect(planRunCleanup(p, "run-a").refusals.join("\n")).toMatch(/still running/);
    } finally {
      lease.release();
    }
    expect(() => planRunCleanup(p, "nope")).toThrow(/not found/);
  });

  it("can be repeated after an interruption and finishes the job", () => {
    env = makeEnv();
    const p = env.project();
    const a = makeRun("run-a");
    let done = 0;
    expect(() =>
      executeRunCleanup(planRunCleanup(p, "run-a"), {
        afterItem: () => {
          if (++done === 1) throw new Error("crash after the first step");
        },
      }),
    ).toThrow(/crash/);
    expect(exists(p.paths.taskMemory, "run-a")).toBe(false); // first step happened
    expect(fs.existsSync(a)).toBe(true); // the run goes last, so it can still be found and retried

    const retry = executeRunCleanup(planRunCleanup(p, "run-a"));
    expect(retry.failed).toEqual([]);
    expect(fs.existsSync(a)).toBe(false);
    expect(() => planRunCleanup(p, "run-a")).toThrow(/not found/);
  });

  it("finishes from its journal when the run directory is already gone", () => {
    env = makeEnv();
    const p = env.project();
    makeRun("run-a");
    let n = 0;
    expect(() =>
      executeRunCleanup(planRunCleanup(p, "run-a"), {
        afterItem: () => {
          if (++n === 2) throw new Error("crash after the run dir was removed");
        },
      }),
    ).toThrow(/crash/);
    expect(exists(p.paths.runs, "run-a")).toBe(false);
    // nothing left to do, but a leftover journal must be accepted and cleared, not reported as an unknown run
    const plan = planRunCleanup(p, "run-a");
    expect(plan.items.every((i) => i.kind !== "run")).toBe(true);
    expect(executeRunCleanup(plan).failed).toEqual([]);
    expect(() => planRunCleanup(p, "run-a")).toThrow(/not found/);
  });
});

describe("clear: symlinks cannot lead deletion outside the project home", () => {
  it("unlinks a symlink inside the run without touching what it points to", () => {
    env = makeEnv();
    const p = env.project();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    extra.push(outside);
    write(path.join(outside, "precious.txt"), "keep\n");
    const a = makeRun("run-a");
    fs.symlinkSync(outside, path.join(a, "evil"));
    executeRunCleanup(planRunCleanup(p, "run-a"));
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("keep\n");
  });

  it("does not follow a task-memory folder that is itself a symlink", () => {
    env = makeEnv();
    const p = env.project();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    extra.push(outside);
    write(path.join(outside, "precious.txt"), "keep\n");
    makeRun("run-a");
    fs.rmSync(path.join(p.paths.taskMemory, "run-a"), { recursive: true });
    fs.symlinkSync(outside, path.join(p.paths.taskMemory, "run-a"));
    executeRunCleanup(planRunCleanup(p, "run-a"));
    expect(fs.existsSync(path.join(p.paths.taskMemory, "run-a"))).toBe(false); // the link is gone
    expect(fs.readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("keep\n"); // its target is not
  });

  it("refuses to delete through a parent folder that is a symlink out of the project home", () => {
    env = makeEnv();
    const p = env.project();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    extra.push(outside);
    write(path.join(outside, "run-a", "precious.txt"), "keep\n");
    fs.rmSync(p.paths.runs, { recursive: true, force: true });
    fs.symlinkSync(outside, p.paths.runs);
    saveRunState(path.join(outside, "run-a"), newRunState({ run_id: "run-a", project: "demo", max_rounds: 5 }));
    const plan = planRunCleanup(p, "run-a");
    const report = executeRunCleanup(plan);
    expect(report.failed.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(outside, "run-a", "precious.txt"))).toBe(true);
  });
});

describe("clear: worktrees and the work in them", () => {
  function runWithWorkspace(opts: { integrate: boolean }) {
    const p = gitEnv();
    const runDir = makeRun("run-a");
    const ref = snapshotBase(p, "run-a", 1);
    const ws = prepareAgentWorkspace(p, "run-a", "fe-member", ref);
    write(path.join(ws.dir, "src/web/feature.txt"), "feature\n");
    if (opts.integrate) expect(integrateAgentChanges(p, collectAgentChanges(ws, ["src/web/**"])).status).toBe("integrated");
    return { p, runDir, ws };
  }

  it("removes a worktree whose work is in the repo, with its branch and snapshots", () => {
    const { p, ws } = runWithWorkspace({ integrate: true });
    const plan = planRunCleanup(p, "run-a");
    expect(plan.refusals).toEqual([]);
    expect(plan.items.map((i) => i.kind)).toEqual(["workspace", "refs", "task-memory", "run"]);
    expect(executeRunCleanup(plan).failed).toEqual([]);
    expect(fs.existsSync(ws.root)).toBe(false);
    expect(git(env.repo, "branch", "--list", "agent-lyceum/*")).toBe("");
    expect(git(env.repo, "for-each-ref", "refs/agent-lyceum")).toBe("");
    expect(git(env.repo, "worktree", "list", "--porcelain")).not.toContain("worktrees/run-a");
    expect(fs.readFileSync(path.join(env.repo, "src/web/feature.txt"), "utf8")).toBe("feature\n"); // the integrated work stays
  });

  it("removes a worktree nobody touched", () => {
    const p = gitEnv();
    makeRun("run-a");
    const ws = prepareAgentWorkspace(p, "run-a", "fe-member", snapshotBase(p, "run-a", 1));
    expect(planRunCleanup(p, "run-a").refusals).toEqual([]);
    executeRunCleanup(planRunCleanup(p, "run-a"));
    expect(fs.existsSync(ws.root)).toBe(false);
  });

  it("refuses, deleting nothing, while a worktree has uncommitted work, and lists it", () => {
    const { p, runDir, ws } = runWithWorkspace({ integrate: false });
    const plan = planRunCleanup(p, "run-a");
    expect(plan.refusals.join("\n")).toMatch(/fe-member.*src\/web\/feature\.txt/s);
    expect(plan.keep.map((k) => k.agent)).toEqual(["fe-member"]);
    expect(() => executeRunCleanup(plan)).toThrow(/refus/i);
    expect(fs.existsSync(runDir)).toBe(true);
    expect(fs.existsSync(path.join(ws.dir, "src/web/feature.txt"))).toBe(true);
    expect(exists(p.paths.taskMemory, "run-a")).toBe(true);
  });

  it("refuses for committed work that never reached the repo, too", () => {
    const { p, ws } = runWithWorkspace({ integrate: false });
    collectAgentChanges(ws, ["src/web/**"]); // commits it on the agent's branch
    expect(git(ws.root, "status", "--porcelain")).toBe("");
    const plan = planRunCleanup(p, "run-a");
    expect(plan.refusals.join("\n")).toMatch(/not (in|brought into) the repo|unintegrated/i);
    expect(plan.refusals.join("\n")).toContain("agent-lyceum/run-a/fe-member");
  });

  it("--keep-worktrees keeps the worktree and its branch but still clears the run and task memory", () => {
    const { p, runDir, ws } = runWithWorkspace({ integrate: false });
    const plan = planRunCleanup(p, "run-a", { keepWorktrees: true });
    expect(plan.refusals).toEqual([]);
    expect(plan.items.map((i) => i.kind)).toEqual(["task-memory", "run"]);
    executeRunCleanup(plan);
    expect(fs.existsSync(runDir)).toBe(false);
    expect(exists(p.paths.taskMemory, "run-a")).toBe(false);
    expect(fs.readFileSync(path.join(ws.dir, "src/web/feature.txt"), "utf8")).toBe("feature\n");
    expect(git(env.repo, "branch", "--list", "agent-lyceum/run-a/fe-member")).toContain("agent-lyceum/run-a/fe-member");
  });
});

describe("the clear command", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.join(here, "..", "src", "cli.ts");
  const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
  const run = (args: string[]) => {
    const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("--dry-run lists what would go and deletes nothing; the real run deletes it", () => {
    env = makeEnv();
    const p = env.project();
    const a = makeRun("run-a");
    const dry = run(["clear", "run-a", "-p", "demo", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/dry run/i);
    expect(dry.out).toContain(path.join(p.paths.taskMemory, "run-a"));
    expect(fs.existsSync(a)).toBe(true);

    const real = run(["clear", "run-a", "-p", "demo"]);
    expect(real.code).toBe(0);
    expect(real.out).toMatch(/deleted run run-a/i);
    expect(fs.existsSync(a)).toBe(false);
  });

  it("exits 1 and lists the unintegrated work when it refuses", () => {
    const p = gitEnv();
    const a = makeRun("run-a");
    const ws = prepareAgentWorkspace(p, "run-a", "fe-member", snapshotBase(p, "run-a", 1));
    write(path.join(ws.dir, "src/web/feature.txt"), "feature\n");
    const r = run(["clear", "run-a", "-p", "demo"]);
    expect(r.code).toBe(1);
    expect(r.err + r.out).toContain("src/web/feature.txt");
    expect(r.err + r.out).toContain("--keep-worktrees");
    expect(fs.existsSync(a)).toBe(true);
    const keep = run(["clear", "run-a", "-p", "demo", "--keep-worktrees"]);
    expect(keep.code).toBe(0);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(ws.root)).toBe(true);
  });
});

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { instanceContainment } from "../src/instance-containment.js";
import { isInside } from "../src/paths.js";
import { loadRunState } from "../src/run-store.js";
import { buildStatusReport, formatStatusReport } from "../src/status.js";
import { logEvents, newWorld, OK, pendingOf, resume, run, send, snapshotTree, type Script, type World } from "./instances-harness.js";

vi.setConfig({ testTimeout: 30_000 });

// Phase C review round 1: component-wise containment, resume judged on the recorded git dir, configured `<role>--2` agents, FIFOs in held mail.

let world: World | undefined;
afterEach(() => {
  world?.env.cleanup();
  world = undefined;
});

const twoFlagged: Script = (w) => {
  if (w.agent === "lead") {
    if (w.n === 1) {
      send(w.i, "fe-member", "task one", "task", "parallel: true\n");
      send(w.i, "fe-member", "task two", "task", "parallel: true\n");
    } else send(w.i, "lead", "bye", "done");
    return;
  }
  send(w.i, "lead", `finished by ${w.agent}`, "reply");
  return;
};

describe("1: `..notes` is a name, not upward traversal", () => {
  it("isInside compares whole components", () => {
    expect(isInside("/w", "/w/..notes")).toBe(true);
    expect(isInside("/w", "/w/..")).toBe(false);
    expect(isInside("/w", "/w/../x")).toBe(false);
    expect(isInside("/w", "/x")).toBe(false);
    expect(isInside("/w", "/w")).toBe(true);
  });

  it("a shared memory at <instance task memory>/..notes conflicts at every caller (activation, post-open, pre-wake, resume share one judgment)", () => {
    world = newWorld();
    const base = structuredClone(world.project);
    const taskRoot = path.join(base.paths.taskMemory, "run-1", "fe-member--2");
    base.agents["fe-member"]!.memory.project = path.join(taskRoot, "..notes");
    const c = instanceContainment(base, world.runDir, "run");
    expect(c.check("fe-member", 2)).toContain("..notes");
    expect(c.checkWorkspace("fe-member", 2, { root: path.join(base.paths.root, "worktrees", "run-1", "fe-member--2"), gitDir: "/nonexistent/git" })).toContain("..notes");
  });

  it("activation ignores parallel for it", async () => {
    world = newWorld((p) => {
      p.agents["fe-member"]!.memory.project = path.join(p.paths.taskMemory, "run-1", "fe-member--2", "..notes");
    });
    const s = await run(world, twoFlagged);
    expect(s.endReason).toBe("done");
    expect(loadRunState(world.runDir).instances).toBeUndefined();
    expect(logEvents(world, "parallel_ignored").length).toBeGreaterThan(0);
  });

  it("resume refuses it with the run unchanged", async () => {
    world = newWorld();
    await run(world, twoFlagged);
    const project = structuredClone(world.project);
    project.agents["fe-member"]!.memory.project = path.join(project.paths.taskMemory, "run-1", "fe-member--2", "..notes");
    const before = snapshotTree(world.runDir);
    await expect(resume(world, async () => OK, { project })).rejects.toThrow(/fe-member--2/);
    expect(snapshotTree(world.runDir)).toEqual(before);
  });
});

describe("2: resume judges an existing instance on its recorded git dir, read-only", () => {
  it("memory.project under instance 2's git dir is refused and nothing is written", async () => {
    world = newWorld();
    await run(world, twoFlagged);
    const root = path.join(world.project.paths.root, "worktrees", "run-1", "fe-member--2");
    const meta = JSON.parse(fs.readFileSync(`${root}.json`, "utf8")) as { gitDir: string };
    const project = structuredClone(world.project);
    project.agents["fe-member"]!.memory.project = path.join(meta.gitDir, "notes");
    const before = { run: snapshotTree(world.runDir), tm: snapshotTree(project.paths.taskMemory), wt: snapshotTree(path.dirname(root)) };
    await expect(resume(world, async () => OK, { project })).rejects.toThrow(new RegExp(`fe-member--2.*${meta.gitDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect({ run: snapshotTree(world.runDir), tm: snapshotTree(project.paths.taskMemory), wt: snapshotTree(path.dirname(root)) }).toEqual(before);
  });
});

describe("3: a configured agent named `<role>--2` is not an instance", () => {
  it("never-parallel run: both agents are woken, no instance table, status shows plain names", async () => {
    world = newWorld((p) => {
      p.agents["fe-member--2"] = structuredClone(p.agents["fe-member"]!);
      p.agents["fe-member--2"]!.name = "fe-member--2";
      p.agents["fe-member"]!.memory.project = path.join(p.paths.taskMemory, "run-1", "fe-member--2");
    });
    const script: Script = (w) => {
      if (w.agent === "lead") {
        if (w.n === 1) send(w.i, "fe-member--2", "job", "task");
        else send(w.i, "lead", "bye", "done");
        return;
      }
      send(w.i, "lead", `finished by ${w.agent}`, "reply");
      return;
    };
    const s = await run(world, script);
    expect(s.endReason).toBe("done");
    expect(world.calls["fe-member--2"]).toBe(1);
    expect(world.lines.join("\n")).not.toContain("was not woken");
    const st = loadRunState(world.runDir);
    expect(st.instances).toBeUndefined();
    expect(st.schema_version).toBe(2);
    const text = formatStatusReport(buildStatusReport(world.project, "run-1"), Date.now(), false);
    expect(text).toContain("fe-member--2");
    expect(text).not.toContain("fe-member #2");
  });
});

describe("4: a FIFO in held mail never hangs status", () => {
  it("status lists the regular held mail and skips the FIFO, in a bounded child", async () => {
    world = newWorld();
    await run(world, twoFlagged);
    const st = loadRunState(world.runDir);
    st.end_reason = undefined;
    fs.writeFileSync(path.join(world.runDir, "state.json"), JSON.stringify(st, null, 2));
    const dir = pendingOf(world, "fe-member");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "20260101T000000000Z-lead-aaaa1111.md"), "---\nid: aaaa1111\nfrom: lead\nto: fe-member\ntype: task\nsubject: regular\n---\n\nbody\n");
    expect(spawnSync("mkfifo", [path.join(dir, "special.md")]).status).toBe(0);
    const root = path.resolve(import.meta.dirname, "..");
    const projectFile = path.join(world.env.root, "project.json");
    fs.writeFileSync(projectFile, JSON.stringify(world.project));
    const script = path.join(world.env.root, "child.mjs");
    fs.writeFileSync(
      script,
      `import fs from "node:fs";import {buildStatusReport} from ${JSON.stringify(pathToFileURL(path.join(root, "src/status.ts")).href)};console.log(JSON.stringify(buildStatusReport(JSON.parse(fs.readFileSync(${JSON.stringify(projectFile)},"utf8")),"run-1").run.queue.map((q)=>q.subject)));`,
    );
    const res = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
    expect((res.error as NodeJS.ErrnoException | undefined)?.code).toBeUndefined();
    expect(JSON.parse(res.stdout)).toEqual(["regular"]);
  });
});

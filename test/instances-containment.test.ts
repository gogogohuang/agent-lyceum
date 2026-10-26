import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexWritableRoots } from "../src/adapters/codex.js";
import { buildClaudeSettings } from "../src/adapters/claude.js";
import { containmentConflict, slotWritableRoots, synthesizeSlots } from "../src/instances.js";
import { canonicalPath } from "../src/paths.js";
import { memoryDirs, writePolicy } from "../src/policy.js";
import { loadRunState } from "../src/run-store.js";
import { PARALLEL_SECTION, buildSystemPrompt, buildUserPrompt } from "../src/prompt.js";
import { bindRunProject } from "../src/run-store.js";
import { LEAD_PARALLEL_HINT } from "../src/scaffold.js";
import { setFaultHook } from "../src/message-store.js";
import { journal, snapshotTree, logEvents, newWorld, OK, resume, run, send, pendingOf, type Script, type World } from "./instances-harness.js";
import type { WakeInput } from "../src/adapters/index.js";

// Real git and several wake-ups per test: the default 5 s is too short when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });

// Spec 23.11 (D-17 containment of the shared memory), 23.12 (prompts), and the single-writer policy of instances 2 and up.

let world: World | undefined;
const tmp: string[] = [];
afterEach(() => {
  world?.env.cleanup();
  world = undefined;
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("containmentConflict / canonicalPath (T-R1-4)", () => {
  const id = (p: string) => p;
  it("reports a path that contains a root, or lies inside one, and nothing for siblings", () => {
    expect(containmentConflict(["/m/shared"], ["/m/shared/run1/fe--2"], id, false)).toEqual({ shared: "/m/shared", root: "/m/shared/run1/fe--2" });
    expect(containmentConflict(["/m/shared/notes"], ["/m/shared"], id, false)).toEqual({ shared: "/m/shared/notes", root: "/m/shared" });
    expect(containmentConflict(["/m/shared"], ["/m/shared-2", "/m/other"], id, false)).toBeUndefined();
  });
  it("darwin compares case-insensitively (a conflict that is not one is accepted), linux does not", () => {
    expect(containmentConflict(["/m/Shared"], ["/m/shared/x"], id, true)).toBeDefined();
    expect(containmentConflict(["/m/Shared"], ["/m/shared/x"], id, false)).toBeUndefined();
  });
  it("canonicalPath sees through a symlink and resolves a path that does not exist yet from its deepest existing ancestor", () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canon-")));
    tmp.push(d);
    fs.mkdirSync(path.join(d, "real"));
    fs.symlinkSync(path.join(d, "real"), path.join(d, "link"));
    expect(canonicalPath(path.join(d, "link", "a", "b"))).toBe(path.join(d, "real", "a", "b"));
    expect(canonicalPath(path.join(d, "missing", "x"))).toBe(path.join(d, "missing", "x"));
  });
  it("slotWritableRoots is the allowed dirs, the folders of editable files and the work dirs, once each", () => {
    expect(slotWritableRoots({ allowDirs: ["/a", "/b"], allowFiles: ["/c/AGENT.md", "/a/x.md"] }, ["/w", "/a"])).toEqual(["/a", "/b", "/c", "/w"]);
  });
});

describe("policy of instance 2 (single writer of shared memory)", () => {
  it("instance 1 writes the shared memory; instance 2 cannot, reads it, and Claude/Codex settings follow", () => {
    world = newWorld();
    const role = "fe-member";
    const bound = bindRunProject(world.project, world.runDir, "run", { roles: { [role]: [role, `${role}--2`] } });
    const one = bound.agents[role]!;
    const two = bound.agents[`${role}--2`]!;
    const shared = [two.sharedMemory?.global, two.sharedMemory?.project].filter((x): x is string => !!x);
    expect(shared.length).toBeGreaterThan(0);
    const p1 = writePolicy(bound, one);
    const p2 = writePolicy(bound, two);
    for (const s of shared) {
      expect(p1.allowDirs).toContain(s);
      expect(p1.deny).not.toContain(s);
      expect(p2.allowDirs).not.toContain(s);
      expect(p2.deny).toContain(s);
      expect(p2.readDirs).toContain(s);
      expect(buildClaudeSettings(bound, two).sandbox?.filesystem?.denyWrite ?? []).toContain(s);
    }
    expect(memoryDirs(two)).toEqual([two.memory.task]);
    expect(two.memory.task).not.toBe(one.memory.task);
    expect(two.canEditAgentMd).toBe(false);
    const roots = codexWritableRoots({ project: bound, agent: two, workDir: "/x" } as unknown as WakeInput);
    for (const s of shared) expect(roots.some((r) => s === r || s.startsWith(r + path.sep))).toBe(false);
  });

  it("even a role that may edit AGENT.md gives instance 2 no root above the shared memory", () => {
    world = newWorld();
    const role = "fe-member";
    world.project.agents[role]!.canEditAgentMd = true;
    const bound = bindRunProject(world.project, world.runDir, "run", { roles: { [role]: [role, `${role}--2`] } });
    const two = bound.agents[`${role}--2`]!;
    const roots = codexWritableRoots({ project: bound, agent: two, workDir: "/x" } as unknown as WakeInput);
    for (const s of Object.values(two.sharedMemory ?? {})) expect(roots.some((r) => s.startsWith(r + path.sep) || s === r)).toBe(false);
  });

  it("synthesizeSlots without a table leaves every agent as it was", () => {
    world = newWorld();
    expect(synthesizeSlots(world.project.agents, { roles: {} }, (s) => s)).toEqual(world.project.agents);
  });
});

describe("instance prompts (23.12)", () => {
  it("PARALLEL_SECTION(4) is the literal block of the spec, without a trailing newline", () => {
    const t = PARALLEL_SECTION(4);
    expect(t.startsWith("## Parallel tasks\nA member can work on up to 4 tasks at the same time")).toBe(true);
    expect(t.endsWith("before you report `done`.")).toBe(true);
    expect(t.split("\n")).toHaveLength(8);
  });
  it("an instance is told who it is, that the shared memory is read-only, and sees the shared index", () => {
    world = newWorld();
    const role = "fe-member";
    const bound = bindRunProject(world.project, world.runDir, "run", { roles: { [role]: [role, `${role}--2`] } });
    const two = bound.agents[`${role}--2`]!;
    const sys = buildSystemPrompt(bound, two);
    expect(sys).toContain(`You are **${role}--2**, instance 2 of **${role}** in the team "demo".`);
    expect(sys).toContain("each in its own worktree");
    expect(sys).toContain(`read-only for you: ${role} maintains it`);
    expect(sys).toContain("You cannot write the shared memory: put lessons worth keeping in your reply to the lead.");
    expect(sys).not.toContain("Use the global/project memory only");
    const one = buildSystemPrompt(bound, bound.agents[role]!);
    expect(one).toContain(`Other instances of you (${role}--2) may work in parallel; only you write your global/project memory.`);
    const dir = Object.values(two.sharedMemory ?? {})[0]!;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "- shared lesson one\n");
    expect(buildUserPrompt(bound, two, [])).toContain("shared lesson one");
  });
  it("a run that never activated the role changes nothing for the member", () => {
    world = newWorld();
    const bound = bindRunProject(world.project, world.runDir, "run");
    const text = buildSystemPrompt(bound, bound.agents["fe-member"]!);
    expect(text).not.toContain("Other instances of you");
    expect(text).not.toContain("instance");
  });
});

const lead = (w: Parameters<Script>[0]): boolean => w.agent === "lead";
/** The lead sends two flagged tasks, members answer, the lead is done after the second round. */
const twoFlagged: Script = (w) => {
  if (lead(w)) {
    if (w.n === 1) {
      send(w.i, "fe-member", "task one", "task", "parallel: true\n");
      send(w.i, "fe-member", "task two", "task", "parallel: true\n");
    } else if (w.n >= 2) send(w.i, "lead", "bye", "done");
    return;
  }
  send(w.i, "lead", `finished by ${w.agent}`, "reply");
  return;
};

async function ignoredRun(configure: (w: World) => void): Promise<World> {
  world = newWorld((p, env) => configure({ project: p, env } as World));
  const s = await run(world, twoFlagged);
  expect(s.endReason).toBe("done");
  return world;
}

function expectIgnored(w: World, shared: string, rootHint: string): void {
  const st = loadRunState(w.runDir);
  expect(st.schema_version).toBe(2);
  expect(st.instances).toBeUndefined();
  expect(fs.existsSync(pendingOf(w, "fe-member"))).toBe(false);
  const ev = logEvents(w, "parallel_ignored");
  expect(ev.length).toBeGreaterThan(0);
  const reason = String(ev[0]?.reason);
  expect(reason).toContain(shared);
  expect(reason).toContain(rootHint);
  expect(w.lines.join("\n")).toContain(shared);
}

describe("D-17 at activation: a conflicting shared memory means parallel is ignored (T-R1-1..3)", () => {
  it("T-R1-1: memory.project is the run's task memory folder", async () => {
    const w = await ignoredRun(({ project }) => {
      project.agents["fe-member"]!.memory.project = path.join(project.paths.taskMemory, "run-1");
    });
    expectIgnored(w, path.join(w.project.paths.taskMemory, "run-1"), "fe-member--2");
  });
  it("T-R1-2: memory.project is a symlink to the run's task memory folder", async () => {
    let link = "";
    const w = await ignoredRun(({ project }) => {
      const target = path.join(project.paths.taskMemory, "run-1");
      fs.mkdirSync(target, { recursive: true });
      link = path.join(project.paths.root, "mem-link");
      fs.symlinkSync(target, link);
      project.agents["fe-member"]!.memory.project = link;
    });
    expectIgnored(w, link, "fe-member--2");
  });
  it("T-R1-3: memory.global is an ancestor of the worktrees folder", async () => {
    const w = await ignoredRun(({ project }) => {
      project.agents["fe-member"]!.memory.global = project.paths.root;
    });
    expectIgnored(w, w.project.paths.root, "fe-member--2");
  });
});

describe("D-17 after the instance is opened and at resume (T-R1-5, T-R1-6)", () => {
  it("T-R1-6: a run with fe-member--2 whose memory.project now holds the instance's task memory cannot be resumed, and nothing is written", async () => {
    world = newWorld();
    const s = await run(world, twoFlagged);
    expect(s.endReason).toBe("done");
    expect(loadRunState(world.runDir).instances?.roles["fe-member"]).toEqual(["fe-member", "fe-member--2"]);
    const project = structuredClone(world.project);
    const taskRoot = path.join(project.paths.taskMemory, "run-1");
    project.agents["fe-member"]!.memory.project = taskRoot;
    const before = { run: snapshotTree(world.runDir), mem: snapshotTree(project.paths.taskMemory) };
    await expect(resume(world, async () => OK, { project })).rejects.toThrow(new RegExp(`fe-member--2.*${taskRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect({ run: snapshotTree(world.runDir), mem: snapshotTree(project.paths.taskMemory) }).toEqual(before);
  });
});

describe("D-17 after the slot is opened (T-R1-5) and the read-only preflight (T-M2-1)", () => {
  it("T-R1-5: the new instance's task memory turned into a symlink: the second task is held (not given to it), the note names the path, the run survives", async () => {
    world = newWorld();
    const taskMem = path.join(world.project.paths.taskMemory, "run-1", "fe-member--2");
    setFaultHook((s) => {
      if (s === "instances:opened") {
        fs.mkdirSync(path.dirname(taskMem), { recursive: true });
        fs.symlinkSync(world!.project.paths.root, taskMem);
      }
    });
    try {
      const s = await run(world, twoFlagged);
      expect(s.endReason).toBe("done");
    } finally {
      setFaultHook(undefined);
    }
    expect(world.lines.join("\n")).toContain(`${taskMem} is not a plain directory`);
    expect(logEvents(world, "instances").some((e) => String(e.refused).includes("not a plain directory"))).toBe(true);
    // the second task was held, never given to the broken instance, and served by instance 1 once it was free
    expect(logEvents(world, "held").map((e) => e.reason)).toContain("containment");
    expect(journalAssigns(world).map((a) => a.slot)).toEqual(["fe-member", "fe-member"]);
  });

  it("T-M2-1: the preflight writes nothing and the lead prompt carries the section only when instances are possible", async () => {
    const prompts: string[] = [];
    const capture: Script = (w) => {
      if (lead(w)) {
        prompts.push(w.i.systemPrompt);
        if (w.n === 1) send(w.i, "fe-member", "task one", "task");
        else send(w.i, "lead", "bye", "done");
        return;
      }
      send(w.i, "lead", "finished", "reply");
      return;
    };
    world = newWorld();
    await run(world, capture);
    const withSection = prompts.at(-1)!;
    expect(withSection.endsWith(`\n\n${PARALLEL_SECTION(4)}`)).toBe(true);
    world.env.cleanup();

    prompts.length = 0;
    world = newWorld((p) => {
      for (const a of Object.values(p.agents)) a.memory.project = p.paths.taskMemory;
    });
    await run(world, capture);
    expect(prompts.at(-1)).not.toContain("## Parallel tasks");
    expect(loadRunState(world.runDir).schema_version).toBe(2);
  });
});

const journalAssigns = (w: World) => journal(w).filter((l) => l.t === "assign");

describe("scaffold (23.12.5)", () => {
  it("a new project's lead AGENT.md carries the parallel guidance; the other personas do not", () => {
    world = newWorld();
    const lead = fs.readFileSync(path.join(world.env.home, "agents", "lead", "AGENT.md"), "utf8");
    expect(lead).toContain(`- ${LEAD_PARALLEL_HINT}`);
    expect(fs.readFileSync(path.join(world.env.home, "agents", "fe-member", "AGENT.md"), "utf8")).not.toContain("parallel: true");
  });
});

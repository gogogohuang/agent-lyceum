import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesizeSlots } from "../src/instances.js";
import { invokeWithSandboxChecks } from "../src/sandbox-invocation.js";
import { loadRunState } from "../src/run-store.js";
import { logEvents, newWorld, resume, run, send, type Script, type World } from "./instances-harness.js";

vi.setConfig({ testTimeout: 30_000 });

// Spec 25.13 / 25.19.1 through RunSession: a refused sandbox preflight is a `config` failure with one check and no spawn.

let world: World | undefined;
afterEach(() => {
  world?.env.cleanup();
  world = undefined;
});

const sandboxed = (w: World): void => {
  w.project.agents["fe-member"]!.sandbox = { write: [w.env.home], network: [], localBinding: false, unixSockets: [] };
};

/** The lead hands one task (or two flagged ones) to fe-member in its first wake-up; nothing else. */
const handOut = (parallel: boolean): Script => (w) => {
  if (w.agent === "lead" && w.n === 1) {
    send(w.i, "fe-member", "task one", "task", parallel ? "parallel: true\n" : "");
    if (parallel) send(w.i, "fe-member", "task two", "task", "parallel: true\n");
  }
  return undefined;
};

const wakes = (w: World) => logEvents(w, "wake");

describe("a refused sandbox preflight through RunSession", () => {
  // A `config` failure stops at once (fallback.ts nextStep) and, for a non-lead agent, ends the run as agent_failed with the
  // reason in state.failure; the lead is not woken with a failure mail (spec 25.19.1 wording differs: reported to the lead).
  it("run: one check, zero spawns, no retry or backup, the run ends naming the reason; rounds count the refused wake", async () => {
    world = newWorld(() => {});
    sandboxed(world);
    const s = await run(world, handOut(false));
    expect(s.endReason).toBe("agent_failed");
    expect(world.calls["fe-member"] ?? 0).toBe(0); // never spawned
    const refused = logEvents(world, "sandbox-refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ agent: "fe-member", path: fs.realpathSync(world.env.home) });
    expect(logEvents(world, "sandbox")).toHaveLength(0);
    const fe = wakes(world).filter((e) => e.agent === "fe-member");
    expect(fe).toHaveLength(1); // one attempt, no backoff retry
    expect(fe[0]).toMatchObject({ ok: false, attempt: 0 });
    expect(logEvents(world, "fallback")).toHaveLength(0);
    expect(fs.existsSync(path.join(world.runDir, "backups"))).toBe(false);
    const st = loadRunState(world.runDir);
    expect(st.failure).toMatchObject({ agent: "fe-member", attempts: 1 });
    expect(st.failure?.error).toContain("sandbox refused");
    expect(st.failure?.error).toContain("checked before invocation");
    const note = String(logEvents(world, "note").map((e) => e.text).find((t) => String(t).includes("fe-member attempt")));
    expect(note).toContain("refused before it started");
    expect(note).toContain("nothing was run");
    expect(note).not.toContain("side effects may have happened");
    // Documented: the refused wake takes a round like any wake (state.rounds is bumped before the invoke).
    expect(st.rounds).toBe(st.wakes.length);
    expect(st.wakes.filter((x) => x.agent === "fe-member")).toHaveLength(1);
  });

  it("resume: the unread task is retried, refused again with exactly one more check, still no spawn", async () => {
    world = newWorld(() => {});
    sandboxed(world);
    await run(world, handOut(false));
    expect(logEvents(world, "sandbox-refused")).toHaveLength(1);
    const roundsBefore = loadRunState(world.runDir).rounds;
    const s = await resume(world, handOut(false), { project: world.project });
    expect(s.endReason).toBe("agent_failed");
    expect(world.calls["fe-member"] ?? 0).toBe(0);
    expect(logEvents(world, "sandbox-refused")).toHaveLength(2);
    expect(loadRunState(world.runDir).rounds).toBe(roundsBefore + 1);
  });

  it("parallel tasks: the run stops at the first refused wake and no member is spawned", async () => {
    world = newWorld(() => {});
    sandboxed(world);
    const s = await run(world, handOut(true));
    expect(s.endReason).toBe("agent_failed");
    expect(world.calls["fe-member"] ?? 0).toBe(0);
    expect(logEvents(world, "sandbox")).toHaveLength(0);
    expect(logEvents(world, "sandbox-refused").length).toBeGreaterThan(0);
  });

  it("dynamic instance: fe-member--2 inherits the role's sandbox and is refused by the same check, without a spawn", async () => {
    world = newWorld(() => {});
    sandboxed(world);
    const agents = synthesizeSlots(world.project.agents, { roles: { "fe-member": ["fe-member", "fe-member--2"] } }, (slot) => path.join(world!.env.root, "tm", slot));
    const inst = agents["fe-member--2"]!;
    expect(inst.sandbox).toEqual(world.project.agents["fe-member"]!.sandbox);
    const events: [string, Record<string, unknown>][] = [];
    let calls = 0;
    const input = { project: world.project, agent: inst, workDir: world.env.root, systemPrompt: "S", userPrompt: "U", timeoutSec: 5 };
    const r = await invokeWithSandboxChecks(async () => {
      calls++;
      return { ok: true, text: "", exitCode: 0, timedOut: false };
    }, input, inst, { event: (n, f) => events.push([n, f]) }, 0);
    expect(r).toMatchObject({ ok: false, kind: "config" });
    expect(calls).toBe(0);
    expect(events.map((e) => [e[0], e[1].agent])).toEqual([["sandbox-refused", "fe-member--2"]]);
  });
});

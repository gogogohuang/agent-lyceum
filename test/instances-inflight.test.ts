import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WakeResult } from "../src/adapters/index.js";
import { loadClaim } from "../src/message-store.js";
import { loadRunState } from "../src/run-store.js";
import { allPrompts, journal, logEvents, newWorld, resume, run, send, type Script, type World } from "./instances-harness.js";

vi.setConfig({ testTimeout: 30_000 });

// Spec 23 eval 9.4 (second half): a wake of one instance interrupted while in flight (after it wrote an outbox draft, before it
// returned) is redone on resume by the same instance, with its own draft; the other instance's finished work is not redone.

let world: World;
afterEach(() => world?.env.cleanup());

const CANCELLED: WakeResult = { ok: false, text: "", exitCode: null, timedOut: false, cancelled: true, error: "cancelled" };
const state = () => loadRunState(world.runDir);
const claimsOf = (agent: string) => {
  const dir = path.join(world.runDir, "mail", "claims");
  return fs.readdirSync(dir).map((f) => loadClaim(world.runDir, f.replace(/\.json$/, ""))).filter((c) => c?.agent === agent);
};

async function scenario(interrupted: "fe-member--2" | "fe-member") {
  world = newWorld();
  const ac = new AbortController();
  const other = interrupted === "fe-member" ? "fe-member--2" : "fe-member";
  let releaseOther!: () => void;
  const otherDone = new Promise<void>((r) => (releaseOther = r));
  const first: Script = async (w) => {
    if (w.agent === "lead") {
      if (w.n === 1) {
        send(w.i, "fe-member", "task one", "task", "parallel: true\n");
        send(w.i, "fe-member", "task two", "task", "parallel: true\n");
      }
      return;
    }
    write(w);
    if (w.agent === interrupted) {
      send(w.i, "lead", `draft from ${w.agent}`, "reply"); // a draft in the outbox, never returned
      await otherDone; // the other instance has finished: this one is still in flight
      ac.abort();
      return CANCELLED;
    }
    send(w.i, "lead", `finished by ${w.agent}`, "reply");
    releaseOther();
    return;
  };
  const s1 = await run(world, first, { signal: ac.signal });
  expect(s1.endReason).toBe("cancelled");
  const assigns = journal(world).filter((l) => l.t === "assign").length;
  const resumed: Script = async (w, wd) => {
    if (w.agent === "lead") {
      if (w.n > 1 && /finished by/.test(allPrompts(wd, "lead")) && allPrompts(wd, "lead").includes(`redone by ${interrupted}`)) send(w.i, "lead", "bye", "done");
      return;
    }
    write(w, `redo-${w.n}`);
    send(w.i, "lead", `${w.agent === interrupted ? "redone" : "again"} by ${w.agent}`, "reply");
    return;
  };
  return { other, assigns, resumed };
}
const write = (w: { agent: string; dir: string }, tag = "built") => {
  const p = path.join(w.dir, `src/web/${w.agent}-${tag}.txt`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x\n");
};

describe("an instance interrupted in flight (eval 9.4)", () => {
  it("fe-member--2 cancelled mid-wake: stays assigned, is redone by --2 with its own draft, instance 1 is not redone, integrated once", async () => {
    const { assigns, resumed } = await scenario("fe-member--2");
    expect(claimsOf("fe-member--2").map((c) => c.status)).toEqual(["abandoned"]);
    expect(claimsOf("fe-member--2")[0]?.status).not.toBe("output_ready");
    const calls = { ...world.calls };
    const s2 = await resume(world, resumed);
    expect(s2.endReason).toBe("done");
    expect(world.calls["fe-member--2"]).toBe((calls["fe-member--2"] ?? 0) + 1);
    expect(world.calls["fe-member"]).toBe(calls["fe-member"]); // instance 1 finished before: not woken again
    const redo = world.prompts["fe-member--2"]?.at(-1) ?? "";
    expect(redo).toContain("draft from fe-member--2");
    expect(redo).not.toContain("finished by fe-member");
    expect(redo).not.toContain("draft from fe-member\n");
    expect(journal(world).filter((l) => l.t === "assign")).toHaveLength(assigns);
    expect(logEvents(world, "assign")).toHaveLength(assigns);
    expect(claimsOf("fe-member--2").map((c) => c.status)).toEqual(["abandoned", "committed"]); // the old claim stays as history; the redo has a new one
    expect(fs.readFileSync(path.join(world.leadDir, "src/web/fe-member--2-redo-2.txt"), "utf8")).toBe("x\n");
    expect(state().instances?.roles["fe-member"]).toEqual(["fe-member", "fe-member--2"]);
  });

  it("instance 1 cancelled mid-wake while --2 finished: --2 is not redone, instance 1 is, with its own draft", async () => {
    const { assigns, resumed } = await scenario("fe-member");
    const calls = { ...world.calls };
    const s2 = await resume(world, resumed);
    expect(s2.endReason).toBe("done");
    expect(world.calls["fe-member--2"]).toBe(calls["fe-member--2"]);
    expect(world.calls["fe-member"]).toBe((calls["fe-member"] ?? 0) + 1);
    const redo = world.prompts["fe-member"]?.at(-1) ?? "";
    expect(redo).toContain("draft from fe-member");
    expect(redo).not.toContain("finished by fe-member--2");
    expect(journal(world).filter((l) => l.t === "assign")).toHaveLength(assigns);
    expect(claimsOf("fe-member--2").map((c) => c.status)).toEqual(["committed"]);
  });
});

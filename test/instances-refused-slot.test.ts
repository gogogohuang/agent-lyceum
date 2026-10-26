import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setFaultHook } from "../src/message-store.js";
import { journal, logEvents, newWorld, run, send, allPrompts, type Script, type World } from "./instances-harness.js";

vi.setConfig({ testTimeout: 30_000 });

// Spec 23.6: a slot refused by the check after it was created stays empty for the rest of the process (resume re-validates it).

let world: World | undefined;
afterEach(() => {
  setFaultHook(undefined);
  world?.env.cleanup();
  world = undefined;
});

/** Two rounds of two flagged tasks each; the lead is done once the members answered all four. */
const rounds: Script = (w, wd) => {
  if (w.agent === "lead") {
    if (w.n === 1) {
      send(w.i, "fe-member", "task one", "task", "parallel: true\n");
      send(w.i, "fe-member", "task two", "task", "parallel: true\n");
    } else if (w.n >= 2 && !wd.notes.round2) {
      wd.notes.round2 = true;
      send(w.i, "fe-member", "task three", "task", "parallel: true\n");
      send(w.i, "fe-member", "task four", "task", "parallel: true\n");
    } else if (allPrompts(wd, "lead").includes("finished task four") || (allPrompts(wd, "lead").includes("finished task three") && wd.notes.round2)) {
      if (["one", "two", "three", "four"].every((n) => allPrompts(wd, "lead").includes(`finished task ${n}`))) send(w.i, "lead", "bye", "done");
    }
    return;
  }
  for (const n of ["one", "two", "three", "four"]) if (w.i.userPrompt.includes(`subject: task ${n}`)) send(w.i, "lead", `finished task ${n}`, "reply");
  return;
};

const slots = (w: World) => journal(w).filter((l) => l.t === "assign").map((l) => l.slot);

describe("a slot refused after it was created is not used again (phase B finding 1)", () => {
  it("injected check: later parallel tasks never reach fe-member--2, which is never woken", async () => {
    world = newWorld();
    // Only the post-create check refuses, once: after "instances:opened" the first check of instance 2 is the rebind's capability
    // probe, the second is openInstance's own; the cap's later checks pass, so only the refused-slot set keeps the slot unused.
    let created = false;
    let seen = 0;
    setFaultHook((step) => {
      if (step === "instances:opened") created = true;
    });
    const s = await run(world, rounds, { instanceCheck: (role, k) => {
        if (!created || k !== 2 || ++seen !== 2) return undefined;
        return `${role} memory overlaps`;
      },
    });
    expect(s.endReason).toBe("done");
    expect(slots(world)).toHaveLength(4);
    expect(slots(world)).not.toContain("fe-member--2");
    expect(world.calls["fe-member--2"] ?? 0).toBe(0);
    expect(logEvents(world, "instances").filter((e) => e.refused).length).toBe(1);
  });

  it("symlinked outbox: no assignment, no wake, nothing written through the alias", async () => {
    world = newWorld();
    const dest = path.join(world.env.root, "aliased-outbox");
    fs.mkdirSync(dest);
    let made = false;
    setFaultHook((step) => {
      if (step === "instances:opened" && !made) {
        made = true;
        fs.symlinkSync(dest, path.join(world!.runDir, "mail/outbox/fe-member--2"));
      }
    });
    const s = await run(world, rounds);
    expect(s.endReason).toBe("done");
    expect(world.lines.join("\n")).toContain("is not a plain directory");
    expect(slots(world)).not.toContain("fe-member--2");
    expect(world.calls["fe-member--2"] ?? 0).toBe(0);
    expect(fs.readdirSync(dest, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())).toEqual([]); // ensureAgentDirs made the folders before the check; no mail went through
  });
});

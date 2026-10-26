import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setFaultHook } from "../src/message-store.js";
import { loadRunState } from "../src/run-store.js";
import type { WakeInput } from "../src/adapters/index.js";
import { allPrompts, boundOf, idIn, journal, logEvents, newWorld, resume, run, send, type Script, type World } from "./instances-harness.js";

// Real git and several wake-ups per test: the default 5 s is too short when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });

// Spec 23.8 fault table: kill the dispatcher at each durable step of enabling, routing, opening and assigning, resume, and check that
// every mail exists exactly once, in the instance the journal recorded, with no false duplicate or rejection.

let world: World;
afterEach(() => {
  setFaultHook(undefined);
  world?.env.cleanup();
});

const STEPS = ["instances:enabled", "route:intent", "route:written", "route:delivered", "route:source-done", "instances:opened", "assign:recorded", "assign:moved"];

function mdFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".md")) out.push(path.join(d, e.name));
    }
  };
  walk(dir);
  return out;
}
const subjectOf = (f: string) => /^subject: (.*)$/m.exec(fs.readFileSync(f, "utf8"))?.[1] ?? "?";

describe("every fault point replays to exactly one delivery in the recorded instance (23.8)", () => {
  for (const step of STEPS) {
    it(step, async () => {
      world = newWorld();
      let armed = false;
      let fired = false;
      const handled: string[] = [];
      const script: Script = async (w, wd) => {
        if (w.agent === "lead") {
          if (w.n === 1) {
            send(w.i, "fe-member", "task one", "task", "parallel: true\n");
            send(w.i, "fe-member", "task two", "task", "parallel: true\n");
            armed = true;
          } else if (allPrompts(wd, "lead").includes("finished task one") && allPrompts(wd, "lead").includes("finished task two")) send(w.i, "lead", "bye", "done");
          return;
        }
        const subj = /^subject: (task \w+)$/m.exec(w.i.userPrompt)?.[1] ?? "?";
        handled.push(`${w.agent}:${subj}`);
        write0(w.dir, w.agent);
        send(w.i, "lead", `finished ${subj}`, "reply");
        return;
      };
      setFaultHook((s) => {
        if (armed && !fired && s === step) {
          fired = true;
          throw new Error(`crash at ${step}`);
        }
      });
      await expect(run(world, script)).rejects.toThrow(`crash at ${step}`);
      setFaultHook(undefined);
      const s2 = await resume(world, script);
      expect(s2.endReason).toBe("done");
      const inbox = mdFiles(path.join(world.runDir, "mail", "inbox"));
      for (const subject of ["task one", "task two"]) expect(inbox.filter((f) => subjectOf(f) === subject), `${subject} delivered once`).toHaveLength(1);
      expect(inbox.filter((f) => /was rejected|Part of .* was not sent/.test(subjectOf(f)))).toEqual([]);
      expect(handled.sort()).toEqual(["fe-member--2:task two", "fe-member:task one"]);
      // each task is in the inbox (pending/ is empty now) of the instance the journal assigned it to
      for (const a of journal(world).filter((l) => l.t === "assign")) {
        const where = inbox.filter((f) => path.basename(f) === a.file).map((f) => path.relative(path.join(world.runDir, "mail", "inbox"), f).split(path.sep)[0]);
        expect(where).toEqual([a.slot]);
      }
      expect(loadRunState(world.runDir).instances?.roles["fe-member"]).toEqual(["fe-member", "fe-member--2"]);
    });
  }

  it("T-R2-5: a torn assign line (crash while it was written) is repaired on the next append and the mail is placed again", async () => {
    world = newWorld();
    let armed = false;
    let fired = false;
    const script: Script = async (w, wd) => {
      if (w.agent === "lead") {
        if (w.n === 1) {
          send(w.i, "fe-member", "task one", "task", "parallel: true\n");
          armed = true;
        } else if (allPrompts(wd, "lead").includes("finished task one")) send(w.i, "lead", "bye", "done");
        return;
      }
      write0(w.dir, w.agent);
      send(w.i, "lead", "finished task one", "reply");
      return;
    };
    setFaultHook((s) => {
      if (armed && !fired && s === "assign:recorded") {
        fired = true;
        const f = path.join(world.runDir, "mail", "journal.jsonl");
        const text = fs.readFileSync(f);
        fs.writeFileSync(f, text.subarray(0, text.length - 10)); // the assign line was cut short
        throw new Error("crash");
      }
    });
    await expect(run(world, script)).rejects.toThrow("crash");
    setFaultHook(undefined);
    const s2 = await resume(world, script);
    expect(s2.endReason).toBe("done");
    const assigns = journal(world).filter((l) => l.t === "assign");
    expect(assigns).toHaveLength(1);
    expect(mdFiles(path.join(world.runDir, "mail", "inbox")).filter((f) => subjectOf(f) === "task one")).toHaveLength(1);
  });
});

function write0(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, `src/web/${name}.txt`), "built\n");
}

describe("T-F2-5: the activation mark after a crash at instances:enabled", () => {
  it("the replayed parallel task's held intent is the role's first held intent, so work journaled before it counts as earlier", async () => {
    world = newWorld();
    let armed = false;
    const script: Script = async (w, wd) => {
      if (w.agent === "lead") {
        if (w.n === 1) {
          send(w.i, "fe-member", "task one", "task", "parallel: true\n");
          armed = true;
        } else if (allPrompts(wd, "lead").includes("finished task one")) send(w.i, "lead", "bye", "done");
        return;
      }
      write0(w.dir, w.agent);
      send(w.i, "lead", "finished task one", "reply");
      return;
    };
    let fired = false;
    setFaultHook((s) => {
      if (armed && !fired && s === "instances:enabled") {
        fired = true;
        throw new Error("crash");
      }
    });
    await expect(run(world, script)).rejects.toThrow("crash");
    setFaultHook(undefined);
    // state already says the role is active, the journal has no held line yet
    expect(loadRunState(world.runDir).instances?.roles["fe-member"]).toEqual(["fe-member"]);
    expect(journal(world).some((l) => l.held === true)).toBe(false);
    await resume(world, script);
    const lines = journal(world);
    const heldIdx = lines.findIndex((l) => l.t === "intent" && l.held === true);
    const taskIdx = lines.findIndex((l) => l.t === "intent" && l.to === "fe-member");
    expect(heldIdx).toBeGreaterThan(-1);
    expect(heldIdx).toBe(taskIdx); // nothing about fe-member was journaled before the held task: the mark is that task
  });
});

describe("T-F2-5 with a ready member claim in the enable window", () => {
  it("the integration failure written by recover() is work from before the activation: the lead's reply reaches instance 1", async () => {
    world = newWorld();
    let armed = false;
    let crashAt: string | undefined;
    let failureId: string | undefined;
    const script: Script = async (w, wd) => {
      if (w.agent === "lead") {
        const id = idIn(w.i.userPrompt, /could not be brought into the repo/);
        if (w.n === 1) send(w.i, "fe-member", "base", "task");
        else if (id && !failureId) {
          failureId = id;
          send(w.i, "fe-member", "redo base", "task", `reply_to: ${id}\n`);
        } else if (allPrompts(wd, "lead").includes("redone base")) send(w.i, "lead", "bye", "done");
        return;
      }
      const redo = /subject: redo base/.test(w.i.userPrompt);
      fs.writeFileSync(path.join(w.dir, "src/web/a.txt"), redo ? "a\n" : "member\n");
      if (!redo) {
        // the lead's worktree has its own edit of the same file, so bringing the member's change in is blocked
        fs.writeFileSync(path.join(wd.leadDir, "src/web/a.txt"), "lead\n");
        // the lead's parallel task is still in its outbox when this wake-up's output is not yet routed
        const bound = boundOf(world);
        send({ project: bound, agent: bound.agents.lead } as WakeInput, "fe-member", "task two", "task", "parallel: true\n");
        armed = true;
      }
      send(w.i, "lead", redo ? "redone base" : "finished base", "reply");
      return;
    };
    setFaultHook((s) => {
      if (armed && !crashAt && (s === "route:intent" || s === "instances:enabled")) {
        crashAt = s;
        throw new Error(`crash at ${s}`);
      }
    });
    // crash 1: the member's wake-up is finished (claim ready) but nothing is routed yet
    await expect(run(world, script)).rejects.toThrow("crash at route:intent");
    expect(loadRunState(world.runDir).instances).toBeUndefined();
    // crash 2: recover() integrates the claim (blocked: the failure is written), then the replay of the parallel task enables the role
    crashAt = undefined;
    armed = true;
    setFaultHook((s) => {
      if (!crashAt && s === "instances:enabled") {
        crashAt = s;
        throw new Error(`crash at ${s}`);
      }
    });
    await expect(resume(world, script)).rejects.toThrow("crash at instances:enabled");
    setFaultHook(undefined);
    expect(loadRunState(world.runDir).instances?.roles["fe-member"]).toEqual(["fe-member"]);
    const failure = journal(world).find((l) => l.t === "intent" && String(l.source).startsWith("integration:"));
    expect(failure, "the integration failure was journaled by recover()").toBeDefined();
    const s3 = await resume(world, script);
    expect(s3.endReason).toBe("done");
    expect(failureId).toBeDefined();
    const redoAssign = logEvents(world, "assign").find((e) => e.rule === "affinity");
    expect(redoAssign?.slot).toBe("fe-member");
    const lines = journal(world);
    expect(lines.findIndex((l) => l.t === "intent" && l.source === failure?.source)).toBeLessThan(lines.findIndex((l) => l.t === "intent" && l.held === true));
    expect(world.prompts["fe-member--2"]?.join("\n") ?? "").not.toContain("redo base");
  });
});

describe("live revision of a held parallel task (phase A finding 2)", () => {
  it("two held parallel tasks, then a revision of the second: the revision follows the second to instance 2", async () => {
    world = newWorld();
    let added = false;
    let target: string | undefined;
    const script: Script = async (w, wd) => {
      if (w.agent === "lead") {
        if (w.n === 1) {
          send(w.i, "fe-member", "task one", "task", "parallel: true\n");
          send(w.i, "fe-member", "task two", "task", "parallel: true\n");
        } else if (!target) {
          // the lead can wake on instance 1's reply before instance 2 has seen task two: wait for the next wake-up
          target = idIn(allPrompts(wd, "fe-member--2"), /subject: task two/);
          if (target) send(w.i, "fe-member", "revision of task two", "task", `reply_to: ${target}\n`);
        } else if (allPrompts(wd, "lead").includes("revised two")) send(w.i, "lead", "bye", "done");
        return;
      }
      added = true;
      const subj = /^subject: (.*)$/m.exec(w.i.userPrompt)?.[1] ?? "?";
      write0(w.dir, w.agent);
      send(w.i, "lead", subj.startsWith("revision") ? "revised two" : `finished ${subj}`, "reply");
      return;
    };
    const s = await run(world, script);
    expect(s.endReason).toBe("done");
    expect(added).toBe(true);
    const handled = Object.entries(world.prompts).flatMap(([a, ps]) => ps.map((p) => `${a}:${/^subject: (.*)$/m.exec(p)?.[1]}`));
    expect(handled).toContain("fe-member--2:revision of task two");
    expect(handled).not.toContain("fe-member:revision of task two");
  });
});

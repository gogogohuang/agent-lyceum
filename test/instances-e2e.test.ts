import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRunState } from "../src/run-store.js";
import { assertSupportedVersion } from "../src/run-store.js";
import { git, write } from "./helpers.js";
import { allPrompts, idIn, journal, logEvents, newWorld, OK, overlap, pendingOf, rateLimited, resume, run, send, snapshotTree, subjectsIn, type Script, type World } from "./instances-harness.js";

// Real git and several wake-ups per test: the default 5 s is too short when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });

// Spec 23.15 (evaluation 9 items 2-5): fake invoker over a real scratch git repo. Two instances in one batch, separate worktrees,
// integration and conflicts, revisions back to the same instance, blocked instances taking no new thread, saturation, D-16.

let world: World;
afterEach(() => world?.env.cleanup());

const A = "src/web/a.txt";
const mine = (w: { agent: string; dir: string }, rel = `src/web/${w.agent}.txt`, text = "built\n") => write(path.join(w.dir, rel), text);
const seenAll = (world: World, ...needles: string[]) => needles.every((n) => allPrompts(world, "lead").includes(n));
const state = () => loadRunState(world.runDir);
const roles = () => state().instances?.roles["fe-member"];
const branches = () => execFileSync("git", ["-C", world.env.repo, "branch", "--list", "agent-lyceum/*"], { encoding: "utf8" });

describe("two instances in one batch (eval 9.2)", () => {
  it("both are woken together in their own worktrees; different files both reach the lead's tree; the state is v3 and the lead sees role+number", async () => {
    world = newWorld();
    const ov = overlap(2);
    const script: Script = async (w, world) => {
      if (w.agent === "lead") {
        if (w.n === 1) {
          send(w.i, "fe-member", "task one", "task", "parallel: true\n");
          send(w.i, "fe-member", "task two", "task", "parallel: true\n");
        } else if (seenAll(world, "(fe-member, instance 1)", "(fe-member, instance 2)")) send(w.i, "lead", "bye", "done");
        return;
      }
      await ov.hold();
      mine(w);
      send(w.i, "lead", `finished by ${w.agent}`, "reply");
      return;
    };
    const s = await run(world, script);
    expect(s.endReason).toBe("done");
    expect(ov.max()).toBe(2);
    expect(world.dirs["fe-member"]?.[0]).toBeTruthy();
    expect(world.dirs["fe-member--2"]?.[0]).toBeTruthy();
    expect(world.dirs["fe-member"]?.[0]).not.toBe(world.dirs["fe-member--2"]?.[0]);
    expect(fs.existsSync(path.join(world.leadDir, "src/web/fe-member.txt"))).toBe(true);
    expect(fs.existsSync(path.join(world.leadDir, "src/web/fe-member--2.txt"))).toBe(true);
    expect(state().schema_version).toBe(3);
    expect(roles()).toEqual(["fe-member", "fe-member--2"]);
    expect(allPrompts(world, "lead")).toContain("from: fe-member--2 (fe-member, instance 2)");
    expect(allPrompts(world, "lead")).toContain("from: fe-member (fe-member, instance 1)");
    expect(journal(world).filter((l) => l.t === "assign")).toHaveLength(2);
    expect(logEvents(world, "assign").map((e) => [e.slot, e.rule]).sort()).toEqual([["fe-member", "parallel"], ["fe-member--2", "parallel"]]);
    // old binaries refuse this run before writing anything
    expect(() => assertSupportedVersion(state().schema_version, 2, "state.json")).toThrow(/Upgrade agent-lyceum/);
  });

  it("the same file in both: the later one is blocked, the lead gets a failure naming it, its branch is kept, and the revision returns to the same instance", async () => {
    world = newWorld();
    const ov = overlap(2);
    const failureIds: string[] = [];
    const script: Script = async (w, world) => {
      if (w.agent === "lead") {
        if (w.n === 1) {
          send(w.i, "fe-member", "task one", "task", "parallel: true\n");
          send(w.i, "fe-member", "task two", "task", "parallel: true\n");
          return;
        }
        const f = idIn(w.i.userPrompt, /subject: fe-member--2's changes could not be brought into the repo/);
        if (f && !failureIds.includes(f)) {
          failureIds.push(f);
          send(w.i, "fe-member", "please redo", "task", `reply_to: ${f}\n`);
        } else if (seenAll(world, "revised by fe-member--2")) send(w.i, "lead", "bye", "done");
        return;
      }
      if (w.agent === "fe-member--2" && w.n === 2) {
        mine(w, A, "a\n"); // give the conflicting change back
        mine(w, "src/web/b2.txt");
        send(w.i, "lead", "revised by fe-member--2", "reply");
        return;
      }
      await ov.hold();
      mine(w, A, `${w.agent} version\n`);
      send(w.i, "lead", `finished by ${w.agent}`, "reply");
      return;
    };
    const s = await run(world, script);
    expect(s.endReason).toBe("done");
    // the later one (instance 2) was blocked, with its branch kept, and its failure names it
    expect(allPrompts(world, "lead")).toContain("fe-member--2's changes could not be brought into the repo");
    expect(branches()).toContain("agent-lyceum/run-1/fe-member--2");
    // the redo went to the same instance, by affinity (it was addressed to the role)
    expect(world.calls["fe-member--2"]).toBe(2);
    expect(world.calls["fe-member"]).toBe(1);
    expect(logEvents(world, "assign").map((e) => [e.slot, e.rule])).toContainEqual(["fe-member--2", "affinity"]);
    expect(state().blocked_integrations ?? []).toEqual([]);
    expect(fs.readFileSync(path.join(world.leadDir, A), "utf8")).toBe("fe-member version\n");
    expect(fs.existsSync(path.join(world.leadDir, "src/web/b2.txt"))).toBe(true);
  });
});

describe("a blocked instance takes no new thread; revisions still reach it (eval 9.3, T-R3-1/2/4, T-R3-6)", () => {
  it("holds an unflagged new task for blocked instance 1 in pending/, runs a parallel one on instance 2, lets the reply to the failure through, then assigns the held one in order", async () => {
    world = newWorld();
    const pendingWhenInstance2Ran: number[] = [];
    let failureId: string | undefined;
    const script: Script = async (w, world) => {
      if (w.agent === "lead") {
        if (w.n === 1) {
          send(w.i, "fe-member", "task one", "task", "parallel: true\n");
          send(w.i, "fe-member", "task two", "task", "parallel: true\n");
        } else if (w.n === 2) {
          failureId = idIn(w.i.userPrompt, /subject: fe-member's changes could not be brought into the repo/);
          send(w.i, "fe-member", "task N unflagged", "task");
          send(w.i, "fe-member", "task three", "task", "parallel: true\n");
        } else if (w.n === 3) {
          send(w.i, "fe-member", "redo the blocked one", "task", `reply_to: ${failureId}\n`);
        } else if (seenAll(world, "reply to N")) send(w.i, "lead", "bye", "done");
        return;
      }
      if (w.agent === "fe-member" && w.n === 1) {
        mine(w, A, "member version\n");
        write(path.join(world.leadDir, A), "someone else's edit\n"); // blocks the integration
      } else if (w.agent === "fe-member" && w.n === 2) {
        mine(w, A, "a\n"); // the revision: the blocked change is given back, a new file is built
        mine(w, "src/web/redo.txt");
      } else if (w.agent === "fe-member" && w.n === 3) {
        mine(w, "src/web/n.txt");
        send(w.i, "lead", "reply to N", "reply");
        return;
      } else if (w.agent === "fe-member--2" && w.n === 2) {
        pendingWhenInstance2Ran.push(subjectsIn(pendingOf(world, "fe-member")).length);
        mine(w, "src/web/three.txt");
      } else mine(w);
      send(w.i, "lead", `finished by ${w.agent} round ${w.n}`, "reply");
      return;
    };
    const s = await run(world, script);
    expect(s.endReason).toBe("done");
    // T-R3-1: while instance 1 was blocked, N sat in pending/ and never reached its inbox
    expect(pendingWhenInstance2Ran).toEqual([1]);
    expect(logEvents(world, "held").map((e) => [e.role, e.reason])).toContainEqual(["fe-member", "blocked"]);
    // the parallel task went to instance 2 meanwhile
    expect(world.calls["fe-member--2"]).toBe(2);
    // T-R3-2: the reply to the failure reached instance 1 (affinity) although it was blocked; T-R3-4: then N was assigned
    const assigns = journal(world).filter((l) => l.t === "assign");
    const order = assigns.map((a) => a.file as string);
    expect(logEvents(world, "assign").filter((e) => e.slot === "fe-member").map((e) => e.rule)).toEqual(["parallel", "affinity", "default"]);
    expect(order.length).toBe(5);
    expect(state().blocked_integrations ?? []).toEqual([]);
    expect(world.calls["fe-member"]).toBe(3);
    expect(fs.existsSync(path.join(world.leadDir, "src/web/n.txt"))).toBe(true);
  });

  it("T-R3-6: before any parallel task, a blocked member still gets an unflagged task in its inbox, as before the feature", async () => {
    world = newWorld();
    const script: Script = async (w, world) => {
      if (w.agent === "lead") {
        if (w.n === 1) send(w.i, "fe-member", "first", "task");
        else if (w.n === 2) send(w.i, "fe-member", "second", "task");
        else send(w.i, "lead", "bye", "done");
        return;
      }
      if (w.n === 1) {
        mine(w, A, "member version\n");
        write(path.join(world.leadDir, A), "someone else's edit\n");
      } else mine(w);
      send(w.i, "lead", `finished ${w.n}`, "reply");
      return;
    };
    const s = await run(world, script);
    expect(s.endReason).toBe("done");
    expect(state().schema_version).toBe(2);
    expect(state().instances).toBeUndefined();
    expect(fs.existsSync(path.join(world.runDir, "mail", "inbox", "fe-member", "pending"))).toBe(false);
    expect(world.calls["fe-member"]).toBe(2);
  });
});

describe("saturation: a full role queues (eval 9.3)", () => {
  it("max_instances 2 with three parallel tasks: two run together, the third waits in pending/ and goes to the first instance that frees up", async () => {
    world = newWorld((p) => {
      p.dispatcher.max_instances = 2;
    });
    const pendingSeen: number[] = [];
    const handled: string[] = [];
    const script: Script = async (w, world) => {
      if (w.agent === "lead") {
        if (w.n === 1) for (const t of ["one", "two", "three"]) send(w.i, "fe-member", `task ${t}`, "task", "parallel: true\n");
        else if (seenAll(world, "finished task three")) send(w.i, "lead", "bye", "done");
        return;
      }
      pendingSeen.push(subjectsIn(pendingOf(world, "fe-member")).length);
      const subj = /^subject: (task \w+)$/m.exec(w.i.userPrompt)?.[1] ?? "?";
      handled.push(`${w.agent}:${subj}`);
      mine(w, `src/web/${subj.replace(/\W/g, "-")}.txt`);
      send(w.i, "lead", `finished ${subj}`, "reply");
      return;
    };
    const s = await run(world, script);
    expect(s.endReason).toBe("done");
    expect(roles()).toEqual(["fe-member", "fe-member--2"]);
    expect(pendingSeen[0]).toBe(1); // the first batch ran with the third task still waiting
    expect(handled.slice(0, 2).sort()).toEqual(["fe-member--2:task two", "fe-member:task one"]);
    expect(handled[2]?.endsWith("task three")).toBe(true);
    expect(logEvents(world, "held").map((e) => e.reason)).toContain("busy");
  });
});

describe("D-16: waiting mail never ends the run silently and never loops", () => {
  const blockInstanceOne: Script = async (w, world) => {
    if (w.agent === "lead") {
      if (w.n === 1) send(w.i, "fe-member", "parallel one", "task", "parallel: true\n");
      else if (w.n === 2) send(w.i, "fe-member", "task N unflagged", "task");
      return;
    }
    mine(w, A, "member version\n");
    write(path.join(world.leadDir, A), "someone else's edit\n");
    send(w.i, "lead", "finished one", "reply");
    return;
  };

  it("T-D16-1/2: every instance blocked: exactly one stall failure and one nudge, the lead is woken with the stall note, the run ends idle", async () => {
    world = newWorld();
    const s = await run(world, blockInstanceOne);
    expect(s.endReason).toBe("idle");
    const leadMail = [...subjectsIn(path.join(world.runDir, "mail", "inbox", "lead", "read")), ...subjectsIn(path.join(world.runDir, "mail", "inbox", "lead"))];
    expect(leadMail.filter((x) => /waiting and nothing is running/.test(x))).toHaveLength(1);
    expect(leadMail.filter((x) => /No done message sent/.test(x))).toHaveLength(1);
    // T-D16-2: the stall mail was new, so the lead was woken with it instead of the run ending there
    expect(world.calls.lead).toBe(4);
    expect(world.prompts.lead?.at(-1)).toMatch(/1 task\(s\) are waiting and nothing else is running: \w+ "task N unflagged" for fe-member \(its earlier work is blocked: reply to the failure about it to redo it\)/);
    expect(subjectsIn(pendingOf(world, "fe-member"))).toHaveLength(1); // kept on disk for the resume
  });

  const coolingScript = (extraLead?: () => void): Script => async (w, world) => {
    if (w.agent === "lead") {
      if (w.n === 1) send(w.i, "fe-member", "parallel one", "task", "parallel: true\n");
      else if (w.n === 2) send(w.i, "fe-member", "parallel two", "task", "parallel: true\n");
      else if (seenAll(world, "finished two")) send(w.i, "lead", "bye", "done");
      extraLead?.();
      return;
    }
    if (w.agent === "fe-member" && !world.notes.conflicted) {
      world.notes.conflicted = true; // the wake that finishes (after the rate-limited call) blocks instance 1
      mine(w, A, "member version\n");
      write(path.join(world.leadDir, A), "someone else's edit\n");
      send(w.i, "lead", "finished one", "reply");
      return;
    }
    mine(w);
    send(w.i, "lead", "finished two", "reply");
    return;
  };
  const withBackup = (sec: number) => (p: import("../src/config.js").ResolvedProject) => {
    p.agents["fe-member"]!.fallback = [{ runtime: "claude-code", model: "backup" }];
    p.dispatcher.fallback_cooldown_sec = sec;
  };
  const rateLimitPrimary = (inner: Script): Script => async (w, world) => (w.agent === "fe-member" && w.n === 1 && !w.i.agent.model ? rateLimited : inner(w, world));

  it("T-D16-3: held only because the model cools down: it waits, then opens a new instance; no stall failure", async () => {
    world = newWorld(withBackup(2));
    const s = await run(world, rateLimitPrimary(coolingScript()));
    expect(s.endReason).toBe("done");
    expect(roles()).toEqual(["fe-member", "fe-member--2"]);
    expect(logEvents(world, "held_wait")).toHaveLength(1);
    expect(logEvents(world, "held").map((e) => e.reason)).toContain("cooldown");
    const leadMail = [...subjectsIn(path.join(world.runDir, "mail", "inbox", "lead", "read")), ...subjectsIn(path.join(world.runDir, "mail", "inbox", "lead"))];
    expect(leadMail.some((x) => /waiting and nothing is running/.test(x))).toBe(false);
  }, 15000);

  it("T-D16-4: a cancel during the cooldown wait ends the run cancelled", async () => {
    world = newWorld(withBackup(60));
    const ac = new AbortController();
    const s = await run(world, rateLimitPrimary(coolingScript()), { signal: ac.signal, sleep: async () => ac.abort() });
    expect(s.endReason).toBe("cancelled");
    expect(logEvents(world, "held_wait")).toHaveLength(1);
  });
});

describe("work from before the first parallel task (F2: T-F2-1, T-F2-2, T-F2-3)", () => {
  /** v2 run: T goes to fe-member and is blocked (failure F), then the lead's first parallel task activates the role. */
  const f2Script = (ids: { t?: string; f?: string; third?: string }): Script => async (w, world) => {
    if (w.agent === "lead") {
      if (w.n === 1) send(w.i, "fe-member", "task T", "task");
      else if (w.n === 2) {
        ids.f = idIn(w.i.userPrompt, /subject: fe-member's changes could not be brought into the repo/);
        send(w.i, "fe-member", "parallel P", "task", "parallel: true\n");
      } else if (w.n === 3) {
        ids.t = world.notes.tId as string;
        send(w.i, "fe-member", "revise T", "task", `reply_to: ${ids.t}\n`);
        send(w.i, "fe-member", "revise F", "task", `reply_to: ${ids.f}\n`);
        send(w.i, "fe-member", "stray new task", "task", "reply_to: ffffffffffff\n");
      } else if (seenAll(world, "done revising")) send(w.i, "lead", "bye", "done");
      return;
    }
    if (w.agent === "fe-member" && w.n === 1) {
      world.notes.tId = idIn(w.i.userPrompt, /subject: task T/);
      mine(w, A, "member version\n");
      write(path.join(world.leadDir, A), "someone else's edit\n");
    } else if (w.agent === "fe-member" && w.n >= 2) {
      mine(w, A, "a\n");
      mine(w, `src/web/rev${w.n}.txt`);
      send(w.i, "lead", `done revising ${w.n}`, "reply");
      return;
    } else mine(w);
    send(w.i, "lead", `finished ${w.agent} ${w.n}`, "reply");
    return;
  };

  it("T-F2-1: the replies to the pre-activation task and to its failure go to instance 1 although it is blocked; a reply_to the journal does not know does not", async () => {
    world = newWorld();
    const s = await run(world, f2Script({}));
    expect(s.endReason).toBe("done");
    expect(state().schema_version).toBe(3);
    expect(roles()).toContain("fe-member--2"); // P found instance 1 blocked and opened instance 2
    const assigns = logEvents(world, "assign");
    expect(assigns.filter((e) => e.slot === "fe-member" && e.rule === "affinity")).toHaveLength(2);
    expect(state().blocked_integrations ?? []).toEqual([]);
    // T-F2-3(a): the stray task whose reply_to is unknown stayed held while instance 1 was blocked (it waited for the integration), then went in as a new thread
    expect(logEvents(world, "held").some((e) => e.reason === "blocked")).toBe(true);
  });

  it("T-F2-2: the same, with the run stopped after the failure and resumed before the first parallel task (still v2 after the resume)", async () => {
    world = newWorld();
    const ac = new AbortController();
    const ids: { f?: string } = {};
    const first: Script = async (w, wd) => {
      const r = await f2Script({})(w, wd);
      if (w.agent === "fe-member" && w.n === 1) ac.abort(); // the failure reaches the lead's mailbox, but nothing wakes the lead
      return r;
    };
    const s1 = await run(world, first, { signal: ac.signal });
    expect(s1.endReason).toBe("cancelled");
    expect(state().schema_version).toBe(2);
    expect(state().instances).toBeUndefined();
    // resume: the lead now sees the failure, sends the first parallel task and then the revisions
    const second: Script = async (w, wd) => {
      if (w.agent === "lead") {
        if (w.n === 2) {
          ids.f = idIn(w.i.userPrompt, /subject: fe-member's changes could not be brought into the repo/);
          send(w.i, "fe-member", "parallel P", "task", "parallel: true\n");
        } else if (w.n === 3) {
          send(w.i, "fe-member", "revise T", "task", `reply_to: ${wd.notes.tId}\n`);
          send(w.i, "fe-member", "revise F", "task", `reply_to: ${ids.f}\n`);
        } else if (seenAll(wd, "done revising")) send(w.i, "lead", "bye", "done");
        return;
      }
      return f2Script({})(w, wd);
    };
    const s2 = await resume(world, second);
    expect(s2.endReason).toBe("done");
    expect(state().schema_version).toBe(3);
    expect(logEvents(world, "assign").filter((e) => e.slot === "fe-member" && e.rule === "affinity")).toHaveLength(2);
    expect(state().blocked_integrations ?? []).toEqual([]);
  });
});

describe("resume of a run with instances (eval 9.5, 23.10)", () => {
  async function finishedV3(): Promise<void> {
    world = newWorld();
    const script: Script = async (w, wd) => {
      if (w.agent === "lead") {
        if (w.n === 1) {
          send(w.i, "fe-member", "task one", "task", "parallel: true\n");
          send(w.i, "fe-member", "task two", "task", "parallel: true\n");
        } else if (seenAll(wd, "(fe-member, instance 2)", "(fe-member, instance 1)")) send(w.i, "lead", "bye", "done");
        return;
      }
      mine(w);
      send(w.i, "lead", `finished by ${w.agent}`, "reply");
      return;
    };
    await run(world, script);
  }
  const tree = () => ({ run: snapshotTree(world.runDir), mem: snapshotTree(world.project.paths.taskMemory) });
  const refuse = async (mutate: (p: typeof world.project) => typeof world.project, message: RegExp) => {
    const before = tree();
    await expect(resume(world, async () => OK, { project: mutate(structuredClone(world.project)) })).rejects.toThrow(message);
    expect(tree()).toEqual(before);
  };

  it("refuses, with nothing written, when the role was removed, became the lead, or its instance name is now a configured agent", async () => {
    await finishedV3();
    await refuse((p) => {
      delete p.agents["fe-member"];
      return p;
    }, /has instances of "fe-member", which is no longer an agent of project demo/);
    await refuse((p) => ({ ...p, lead: "fe-member" }), /now the lead/);
    await refuse((p) => {
      p.agents["fe-member--2"] = structuredClone(p.agents["fe-member"]!);
      return p;
    }, /"fe-member--2"/);
  });

  it("refuses when the injected containment check finds a conflict for an opened instance", async () => {
    await finishedV3();
    const before = tree();
    await expect(resume(world, async () => OK, { instanceCheck: (role, k) => (k === 2 ? `${role} memory overlaps` : undefined) })).rejects.toThrow(/fe-member--2 fe-member memory overlaps/);
    expect(tree()).toEqual(before);
  });

  it("a lowered cap keeps assigned work and revisions with the instance, takes no new thread above the cap, and the run ends fine", async () => {
    world = newWorld();
    const ac = new AbortController();
    const ids: Record<string, string | undefined> = {};
    const first: Script = async (w, wd) => {
      if (w.agent === "lead") {
        if (w.n === 1) {
          send(w.i, "fe-member", "task one", "task", "parallel: true\n");
          send(w.i, "fe-member", "task two", "task", "parallel: true\n");
        } else if (w.n === 2) {
          ids.two = wd.notes.twoId as string;
          send(w.i, "fe-member", "revise two", "task", `reply_to: ${ids.two}\n`);
          send(w.i, "fe-member", "task three", "task", "parallel: true\n");
          send(w.i, "fe-member--2", "direct new thread", "task");
          ac.abort();
        }
        return;
      }
      if (w.agent === "fe-member--2" && w.n === 1) wd.notes.twoId = idIn(w.i.userPrompt, /subject: task two/);
      mine(w);
      send(w.i, "lead", `finished by ${w.agent} ${w.n}`, "reply");
      return;
    };
    const s1 = await run(world, first, { signal: ac.signal });
    expect(s1.endReason).toBe("cancelled");
    expect(roles()).toEqual(["fe-member", "fe-member--2"]);
    world.project.dispatcher.max_instances = 1;
    world.calls.lead = 2;
    const second: Script = async (w, wd) => {
      if (w.agent === "lead") {
        if (seenAll(wd, "finished by fe-member--2 2")) send(w.i, "lead", "bye", "done");
        return;
      }
      mine(w, `src/web/${w.agent}-${w.n}.txt`);
      send(w.i, "lead", `finished by ${w.agent} ${w.n}`, "reply");
      return;
    };
    const s2 = await resume(world, second);
    expect(s2.endReason).toBe("done");
    const assigns = logEvents(world, "assign");
    expect(assigns.find((e) => e.rule === "affinity")?.slot).toBe("fe-member--2"); // the revision went home although it is above the cap now
    expect(assigns.find((e) => e.rule === "parallel" && e.slot === "fe-member")).toBeTruthy(); // the new parallel task took the one instance the cap allows
    expect(logEvents(world, "held").map((e) => e.reason)).toContain("cap"); // the new thread addressed to instance 2 waits
    expect(subjectsIn(pendingOf(world, "fe-member"))).toContain("direct new thread");
  });
});

// keep the unused helper import honest
void git;

describe("only the lead's flag opens instances (T-R4-3 e2e)", () => {
  it("a member's `parallel: true` task to an active role is held without the flag, goes to instance 1 by the default rule and opens nothing", async () => {
    world = newWorld((p) => {
      p.agents["qa-member"]!.canMessage = ["lead", "fe-member"];
    });
    const script: Script = async (w, wd) => {
      if (w.agent === "lead") {
        if (w.n === 1) {
          send(w.i, "fe-member", "task one", "task", "parallel: true\n");
          send(w.i, "qa-member", "please check", "task");
        } else if (seenAll(wd, "finished by fe-member", "qa asked")) send(w.i, "lead", "bye", "done");
        return;
      }
      if (w.agent === "qa-member") {
        send(w.i, "fe-member", "from qa", "task", "parallel: true\n");
        send(w.i, "lead", "qa asked", "reply");
        return;
      }
      mine(w, `src/web/${w.agent}-${w.n}.txt`);
      send(w.i, "lead", `finished by ${w.agent} ${w.n}`, "reply");
      return;
    };
    const s = await run(world, script);
    expect(s.endReason).toBe("done");
    expect(roles()).toEqual(["fe-member"]);
    const fromQa = journal(world).find((l) => l.t === "intent" && l.to === "fe-member" && String(l.file).includes("-qa-member-"));
    expect(fromQa).toMatchObject({ held: true });
    expect(fromQa).not.toHaveProperty("parallel");
    expect(logEvents(world, "parallel_ignored").map((e) => e.reason)).toEqual(["not-lead"]);
    expect(logEvents(world, "assign").map((e) => [e.slot, e.rule]).sort()).toEqual([["fe-member", "default"], ["fe-member", "parallel"]]);
  });
});

describe("role-scoped affinity across two active roles (T-F1-1 e2e)", () => {
  it("a revision of a mail sent by fe-member--2 and placed in qa-member--2 returns to fe-member--2 for the frontend and to qa-member--2 for qa", async () => {
    world = newWorld((p) => {
      p.agents["fe-member"]!.canMessage = ["lead", "qa-member"];
    });
    const script: Script = async (w, wd) => {
      const subject = /^subject: (.*)$/m.exec(w.i.userPrompt)?.[1] ?? "";
      if (w.agent === "lead") {
        if (w.n === 1) for (const to of ["fe-member", "fe-member", "qa-member", "qa-member"]) send(w.i, to, `par ${++(wd.notes.k as { n: number }).n}`, "task", "parallel: true\n");
        else if (wd.notes.mId && !wd.notes.revised) {
          wd.notes.revised = true;
          send(w.i, "fe-member", "rev for fe", "task", `reply_to: ${wd.notes.mId}\n`);
          send(w.i, "qa-member", "rev for qa", "task", `reply_to: ${wd.notes.mId}\n`);
        } else if (seenAll(wd, "revised fe", "revised qa")) send(w.i, "lead", "bye", "done");
        return;
      }
      if (w.agent === "fe-member--2" && w.n === 1) send(w.i, "qa-member--2", "M check", "task");
      if (subject === "M check") wd.notes.mId = idIn(w.i.userPrompt, /subject: M check/);
      if (subject === "rev for fe") send(w.i, "lead", "revised fe", "reply");
      else if (subject === "rev for qa") send(w.i, "lead", "revised qa", "reply");
      else send(w.i, "lead", `ok ${w.agent} ${w.n}`, "reply");
      return;
    };
    world.notes.k = { n: 0 };
    const s = await run(world, script);
    expect(s.endReason).toBe("done");
    expect(state().instances?.roles).toEqual({ "fe-member": ["fe-member", "fe-member--2"], "qa-member": ["qa-member", "qa-member--2"] });
    const aff = logEvents(world, "assign").filter((e) => e.rule === "affinity").map((e) => e.slot).sort();
    expect(aff).toEqual(["fe-member--2", "qa-member--2"]);
    expect(logEvents(world, "assign").some((e) => e.rule === "addressed" && e.slot === "qa-member--2")).toBe(true);
  });
});

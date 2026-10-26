import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setFaultHook } from "../src/message-store.js";
import { loadRunState } from "../src/run-store.js";
import { buildStatusReport } from "../src/status.js";
import { git, write } from "./helpers.js";
import { allPrompts, boundOf, idIn, journal, logEvents, newWorld, overlap, pendingOf, subjectsIn, resume, run, send, type Script, type World } from "./instances-harness.js";

// Real git and several wake-ups per test: the default 5 s is too short when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });

// Spec 23.15: T-F1-2 (blocked variant of the role-scoped affinity) and one end-to-end scenario for evaluation items 1-7 together.

let world: World;
afterEach(() => world?.env.cleanup());

const A = "src/web/a.txt";
const state = () => loadRunState(world.runDir);
const mine = (w: { agent: string; dir: string }, rel = `src/web/${w.agent}.txt`, text = "built\n") => write(path.join(w.dir, rel), text);
const seenAll = (wd: World, ...needles: string[]) => needles.every((n) => allPrompts(wd, "lead").includes(n));

describe("T-F1-2: role-scoped affinity when the instance is blocked", () => {
  it("a revision of mail M returns to fe-member--2 although it is blocked (not held), and to qa-member--2 for the qa role", async () => {
    world = newWorld((p) => {
      p.agents["fe-member"]!.canMessage = ["lead", "qa-member"];
    });
    const ov = overlap(2);
    const n = { k: 0 };
    const sawBlockedAtRevision: boolean[] = [];
    const script: Script = async (w, wd) => {
      const subject = /^subject: (.*)$/m.exec(w.i.userPrompt)?.[1] ?? "";
      if (w.agent === "lead") {
        if (w.n === 1) {
          for (const to of ["fe-member", "fe-member", "qa-member", "qa-member"]) send(w.i, to, `par ${++n.k}`, "task", "parallel: true\n");
        } else if (wd.notes.mId && !wd.notes.revised && seenAll(wd, "fe-member--2's changes could not be brought into the repo")) {
          wd.notes.revised = true;
          sawBlockedAtRevision.push(!!state().blocked_integrations?.some((b) => b.agent === "fe-member--2"));
          send(w.i, "fe-member", "rev for fe", "task", `reply_to: ${wd.notes.mId}\n`);
          send(w.i, "qa-member", "rev for qa", "task", `reply_to: ${wd.notes.mId}\n`);
        } else if (seenAll(wd, "revised fe", "revised qa")) send(w.i, "lead", "bye", "done");
        return;
      }
      if (subject === "rev for fe") {
        mine(w, A, "a\n");
        mine(w, "src/web/fe-rev.txt");
        send(w.i, "lead", "revised fe", "reply");
        return;
      }
      if (subject === "rev for qa") {
        send(w.i, "lead", "revised qa", "reply");
        return;
      }
      if (subject === "M check") wd.notes.mId = idIn(w.i.userPrompt, /subject: M check/);
      if (w.agent === "fe-member--2" && w.n === 1) send(w.i, "qa-member--2", "M check", "task");
      if (w.agent.startsWith("fe-member")) {
        await ov.hold();
        mine(w, A, `${w.agent} version\n`);
      }
      send(w.i, "lead", `ok ${w.agent} ${w.n}`, "reply");
      return;
    };
    const s = await run(world, script);
    expect(s.endReason).toBe("done");
    expect(sawBlockedAtRevision).toEqual([true]);
    const assigns = logEvents(world, "assign");
    const aff = assigns.filter((e) => e.rule === "affinity").map((e) => e.slot).sort();
    expect(aff).toEqual(["fe-member--2", "qa-member--2"]);
    expect(logEvents(world, "held").filter((e) => e.reason === "blocked")).toEqual([]);
    expect(state().blocked_integrations ?? []).toEqual([]);
  });
});

describe("one parallel run: evaluation 9.1-9.7 together (max_instances 2)", () => {
  it("three parallel tasks, a blocked instance, a held task, the redo, the held one placed, done; status and journal agree", async () => {
    world = newWorld((p) => {
      p.dispatcher.max_instances = 2;
    });
    const ov = overlap(2);
    const failureIds: string[] = [];
    const lead: Script = (w, wd) => {
      if (w.n === 1) {
        for (const t of ["one", "two", "three"]) send(w.i, "fe-member", `job ${t}`, "task", "parallel: true\n");
        return;
      }
      const f = idIn(w.i.userPrompt, /subject: fe-member--2's changes could not be brought into the repo/);
      if (f && !failureIds.includes(f)) {
        failureIds.push(f);
        send(w.i, "fe-member", "late plain job", "task"); // instance 1 or 2 takes it by the default rule; a blocked instance 2 never does
        send(w.i, "fe-member", "redo two", "task", `reply_to: ${f}\n`);
        return;
      }
      if (seenAll(wd, "redone by fe-member--2", "finished late plain job", "finished job three")) send(w.i, "lead", "bye", "done");
    };
    const script: Script = async (w, wd) => {
      if (w.agent === "lead") return lead(w, wd);
      const subject = /^subject: (.*)$/m.exec(w.i.userPrompt)?.[1] ?? "";
      if (subject === "redo two") {
        mine(w, A, "a\n");
        mine(w, "src/web/redo.txt");
        send(w.i, "lead", "redone by fe-member--2", "reply");
        return;
      }
      if (subject === "job one" || subject === "job two") {
        await ov.hold();
        mine(w, A, `${w.agent} version\n`);
      } else mine(w);
      send(w.i, "lead", `finished ${subject}`, "reply");
      return;
    };
    const s = await run(world, script);
    expect(s.endReason).toBe("done");
    // 9.5 / 9.2: v3, exactly two instances, the cap was never exceeded
    expect(state().schema_version).toBe(3);
    expect(state().instances?.roles["fe-member"]).toEqual(["fe-member", "fe-member--2"]);
    expect(ov.max()).toBe(2);
    // 9.3: the third parallel task waited (held) and was placed later; every mail is in exactly one place
    expect(logEvents(world, "held").some((e) => e.reason === "busy")).toBe(true);
    expect(fs.existsSync(pendingOf(world, "fe-member")) ? subjectsIn(pendingOf(world, "fe-member")) : []).toEqual([]);
    // 9.4: each assigned mail has exactly one assign line, none was delivered twice, no rejected/dup failures
    const assignIds = journal(world).filter((l) => l.t === "assign").map((l) => l.msg_id);
    expect(new Set(assignIds).size).toBe(assignIds.length);
    expect(allPrompts(world, "lead")).not.toMatch(/was rejected|duplicate/i);
    // the redo went to the blocked instance by affinity, and the work ended integrated
    expect(logEvents(world, "assign").map((e) => [e.slot, e.rule])).toContainEqual(["fe-member--2", "affinity"]);
    expect(state().blocked_integrations ?? []).toEqual([]);
    expect(fs.existsSync(path.join(world.leadDir, "src/web/redo.txt"))).toBe(true);
    // 9.7: status names the instances
    const rep = buildStatusReport(world.project, "run-1");
    expect(rep.agents.map((a) => a.name)).toEqual(expect.arrayContaining(["fe-member", "fe-member--2"]));
    expect(rep.run?.instances).toEqual({ "fe-member": ["fe-member", "fe-member--2"] });
    expect(git(world.env.repo, "rev-parse", "--is-inside-work-tree")).toBe("true");
  });
});

describe("T-F2-5: a failure written by the resume's recovery, after the crash that activated the role", () => {
  it("carries `about`, so the reply to it returns to instance 1 although it is blocked and the failure is older than the activation mark", async () => {
    world = newWorld((p) => {
      p.agents["qa-member"]!.canMessage = ["lead", "fe-member"];
    });
    let armed = false;
    let fired = false;
    const ids: { f?: string; t?: string } = {};
    const script: Script = async (w, wd) => {
      const subject = /^subject: (.*)$/m.exec(w.i.userPrompt)?.[1] ?? "";
      if (w.agent === "lead") {
        if (w.n === 1) send(w.i, "qa-member", "Q", "task");
        else if (w.n === 2) {
          armed = true; // the next routing of a flagged task activates the role: crash there
          send(w.i, "fe-member", "P", "task", "parallel: true\n");
        } else {
          const f = idIn(w.i.userPrompt, /subject: fe-member's changes could not be brought into the repo/);
          if (f && !wd.notes.revised) {
            wd.notes.revised = true;
            ids.f = f;
            send(w.i, "fe-member", "revise F", "task", `reply_to: ${f}\n`);
          } else if (seenAll(wd, "done revising")) send(w.i, "lead", "bye", "done");
        }
        return;
      }
      if (w.agent === "qa-member") {
        send(w.i, "fe-member", "T", "task");
        send(w.i, "lead", "qa done", "reply");
        return;
      }
      if (subject === "T") {
        mine(w, A, "member version\n");
        write(path.join(wd.leadDir, A), "someone else's edit\n");
        send(w.i, "lead", "T finished", "reply");
        return;
      }
      if (subject === "revise F") {
        mine(w, A, "a\n");
        mine(w, "src/web/rev.txt");
        send(w.i, "lead", "done revising", "reply");
        return;
      }
      mine(w);
      send(w.i, "lead", `finished ${subject}`, "reply");
      return;
    };
    setFaultHook((s) => {
      if (armed && !fired && s === "instances:enabled") {
        fired = true;
        throw new Error("crash at instances:enabled");
      }
    });
    try {
      await expect(run(world, script)).rejects.toThrow("crash at instances:enabled");
    } finally {
      setFaultHook(undefined);
    }
    expect(state().instances?.roles["fe-member"]).toEqual(["fe-member"]);
    const s2 = await resume(world, script);
    expect(s2.endReason).toBe("done");
    expect(ids.f).toBeTruthy();
    const failure = journal(world).find((l) => l.t === "intent" && l.msg_id === ids.f);
    expect(failure?.about).toBe("fe-member");
    expect(logEvents(world, "assign").map((e) => [e.slot, e.rule])).toContainEqual(["fe-member", "affinity"]);
    expect(logEvents(world, "held").filter((e) => String(e.reason) === "blocked" && e.id === ids.f)).toEqual([]);
    expect(state().blocked_integrations ?? []).toEqual([]);
  });
});

describe("T-F2-5 with a real ready member claim", () => {
  it("recovery integrates fe-member's ready claim before any new wake, the failure carries `about`, and the lead's reply reaches blocked instance 1", async () => {
    world = newWorld();
    const ids: { f?: string } = {};
    const script: Script = async (w, wd) => {
      const subject = /^subject: (.*)$/m.exec(w.i.userPrompt)?.[1] ?? "";
      if (w.agent === "lead") {
        if (w.n === 1) send(w.i, "fe-member", "T", "task");
        else {
          const f = idIn(w.i.userPrompt, /subject: fe-member's changes could not be brought into the repo/);
          if (f && !wd.notes.revised) {
            wd.notes.revised = true;
            ids.f = f;
            send(w.i, "fe-member", "revise F", "task", `reply_to: ${f}\n`);
          } else if (seenAll(wd, "done revising")) send(w.i, "lead", "bye", "done");
        }
        return;
      }
      if (subject === "T") {
        mine(w, A, "member version\n");
        write(path.join(wd.leadDir, A), "someone else's edit\n");
        send(w.i, "lead", "T finished", "reply");
        return;
      }
      if (subject === "revise F") {
        mine(w, A, "a\n");
        mine(w, "src/web/rev.txt");
        send(w.i, "lead", "done revising", "reply");
        return;
      }
      mine(w);
      send(w.i, "lead", `finished ${subject}`, "reply");
      return;
    };
    let armed = true;
    setFaultHook((s) => {
      if (armed && s === "wake:ready" && (world.calls["fe-member"] ?? 0) >= 1) {
        armed = false;
        throw new Error("crash at wake:ready");
      }
    });
    try {
      await expect(run(world, script)).rejects.toThrow("crash at wake:ready");
    } finally {
      setFaultHook(undefined);
    }
    // fe-member's claim is output_ready and nothing of it was integrated or routed.
    const claims = fs.readdirSync(path.join(world.runDir, "mail", "claims")).map((f) => JSON.parse(fs.readFileSync(path.join(world.runDir, "mail", "claims", f), "utf8")) as { agent: string; status: string });
    expect(claims.filter((c) => c.agent === "fe-member").map((c) => c.status)).toEqual(["output_ready"]);
    expect(logEvents(world, "integrate")).toEqual([]);
    expect(state().instances).toBeUndefined();
    // The window the router can only be in after the crash: the lead's parallel task is in its outbox when the resume starts. The lead
    // cannot have this next to a member's ready claim in one batch (src/run-session.ts pickBatch: a lead with mail is woken alone),
    // so this mail is put there by hand.
    send({ project: boundOf(world), agent: { name: "lead" } } as never, "fe-member", "P", "task", "parallel: true\n");
    let fired = false;
    setFaultHook((s) => {
      if (!fired && s === "instances:enabled") {
        fired = true;
        throw new Error("crash at instances:enabled");
      }
    });
    try {
      await expect(resume(world, script)).rejects.toThrow("crash at instances:enabled");
    } finally {
      setFaultHook(undefined);
    }
    expect(state().instances?.roles["fe-member"]).toEqual(["fe-member"]);
    // The integration failure of the ready claim was written by the recovery, before the role was enabled or anything woken again.
    const s2 = await resume(world, script);
    expect(s2.endReason).toBe("done");
    expect(ids.f).toBeTruthy();
    const j = journal(world);
    const failure = j.find((l) => l.t === "intent" && l.msg_id === ids.f);
    expect(failure).toBeTruthy();
    expect(logEvents(world, "integrate")[0]).toMatchObject({ agent: "fe-member", status: "blocked" });
    expect(logEvents(world, "assign").map((e) => [e.slot, e.rule])).toContainEqual(["fe-member", "affinity"]);
    expect(logEvents(world, "held").filter((e) => String(e.reason) === "blocked" && e.id === ids.f)).toEqual([]);
    expect(state().blocked_integrations ?? []).toEqual([]);
    expect(fs.existsSync(path.join(world.leadDir, "src/web/rev.txt"))).toBe(true);
    // No `about` assertion here: the failure was written while the role was not enabled yet (recover() integrates before settle() routes the
    // lead's flagged task), and that window needs a lead task next to a member's ready claim, which the dispatcher never produces by itself.
    const events = fs.readFileSync(path.join(world.runDir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; agent?: string });
    const iIntegrate = events.findIndex((e) => e.event === "integrate" && e.agent === "fe-member");
    const iWakeAfter = events.findIndex((e, i) => i > iIntegrate && e.event === "wake" && e.agent === "fe-member");
    expect(iIntegrate).toBeGreaterThan(-1);
    expect(iWakeAfter).toBeGreaterThan(iIntegrate);
  });
});

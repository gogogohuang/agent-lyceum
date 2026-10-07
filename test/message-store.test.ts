import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { finishDone, listUnread, routeOutboxes } from "../src/mailbox.js";
import { claimMessages, commitClaim, loadClaim, recoverRunMail, setFaultHook } from "../src/message-store.js";
import { inboxDir, outboxDir } from "../src/policy.js";
import { bindRunProject, loadRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { FULL_DONE, makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => {
  setFaultHook(undefined);
  env?.cleanup();
});

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
type P = ReturnType<typeof bindRunProject>;

function bound(): P {
  env = makeEnv();
  const base = env.project();
  return bindRunProject(base, path.join(base.paths.runs, "run-a"), "run");
}
const sendFile = (p: P, from: string, to: string | string[], subject: string, type = "task") =>
  write(
    path.join(outboxDir(p, from), `${subject.replace(/\W+/g, "-")}.md`),
    `---\nto: ${JSON.stringify(to)}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${type === "done" ? FULL_DONE : `body of ${subject}`}\n`,
  );
/** Every copy of a subject that reached `agent`, whether still unread or already read. */
const copies = (p: P, agent: string, subject: string): string[] => {
  const dir = inboxDir(p, agent);
  const files = [...(fs.existsSync(dir) ? fs.readdirSync(dir) : []).map((f) => path.join(dir, f)), ...(fs.existsSync(path.join(dir, "read")) ? fs.readdirSync(path.join(dir, "read")).map((f) => path.join(dir, "read", f)) : [])];
  return files.filter((f) => fs.statSync(f).isFile() && fs.readFileSync(f, "utf8").includes(`subject: ${subject}`));
};

/** Run `body` once per possible crash point: throw at the nth journal/rename/delivery step, then "restart" with `after`. */
function crashEverywhere(body: () => void, after: () => void, fresh: () => void): number {
  let points = 0;
  for (let n = 1; n < 60; n++) {
    fresh();
    let step = 0;
    let crashed = false;
    setFaultHook((name) => {
      if (++step === n) {
        crashed = true;
        throw new Error(`crash at ${name}`);
      }
    });
    try {
      body();
    } catch {
      /* the process "died" here */
    }
    setFaultHook(undefined);
    after();
    if (!crashed) return points;
    points++;
  }
  throw new Error("crash points never ran out");
}

describe("route journal: every crash point", () => {
  it("never loses or duplicates mail to either recipient of a two-recipient message", () => {
    let p!: P;
    const points = crashEverywhere(
      () => routeOutboxes(p),
      () => {
        routeOutboxes(p); // the restarted dispatcher routes again
        expect(copies(p, "fe-member", "split job")).toHaveLength(1);
        expect(copies(p, "qa-member", "split job")).toHaveLength(1);
        expect(fs.readdirSync(outboxDir(p, "lead")).filter((f) => f.endsWith(".md"))).toEqual([]);
        expect(fs.existsSync(path.join(outboxDir(p, "lead"), "sent", "split-job.md"))).toBe(true);
      },
      () => {
        env?.cleanup();
        p = bound();
        sendFile(p, "lead", ["fe-member", "qa-member"], "split job");
      },
    );
    expect(points).toBeGreaterThanOrEqual(6);
  });

  it("answers a rejected message once, however often it is interrupted", () => {
    let p!: P;
    crashEverywhere(
      () => routeOutboxes(p),
      () => {
        routeOutboxes(p);
        expect(copies(p, "fe-member", "Message bad.md was rejected")).toHaveLength(1);
      },
      () => {
        env?.cleanup();
        p = bound();
        write(path.join(outboxDir(p, "fe-member"), "bad.md"), "no frontmatter at all");
      },
    );
  });

  it("re-delivers with the same id and timestamp instead of inventing new ones", () => {
    const p = bound();
    sendFile(p, "lead", ["fe-member"], "stable");
    let step = 0;
    setFaultHook(() => {
      if (++step === 3) throw new Error("crash");
    });
    expect(() => routeOutboxes(p)).toThrow(/crash/);
    setFaultHook(undefined);
    routeOutboxes(p);
    const [file] = copies(p, "fe-member", "stable");
    const first = fs.readFileSync(file, "utf8");
    // YAML quotes an id that reads like a number (e.g. "9e207750"), so the quotes are optional
    expect(first).toMatch(/id: "?[0-9a-f]{8}"?/);
    // a second full pass over the same journal changes nothing
    routeOutboxes(p);
    expect(copies(p, "fe-member", "stable")).toEqual([file]);
    expect(fs.readFileSync(file, "utf8")).toBe(first);
  });

  it("delivers two identical messages the agent really sent twice", () => {
    const p = bound();
    sendFile(p, "lead", "fe-member", "again");
    routeOutboxes(p);
    const mtimeGap = new Date(Date.now() + 5000);
    sendFile(p, "lead", "fe-member", "again");
    fs.utimesSync(path.join(outboxDir(p, "lead"), "again.md"), mtimeGap, mtimeGap);
    routeOutboxes(p);
    expect(copies(p, "fe-member", "again")).toHaveLength(2);
  });
});

describe("done message", () => {
  it("stays in the outbox until the run has stored its result", () => {
    const p = bound();
    sendFile(p, "lead", "lead", "all done", "done");
    const r1 = routeOutboxes(p);
    expect(r1.done?.subject).toBe("all done");
    expect(fs.existsSync(path.join(outboxDir(p, "lead"), "all-done.md"))).toBe(true);
    // a restart before finishing finds it again
    expect(routeOutboxes(p).done?.subject).toBe("all done");
    finishDone(r1.done!.file);
    expect(fs.existsSync(path.join(outboxDir(p, "lead"), "all-done.md"))).toBe(false);
    expect(routeOutboxes(p).done).toBeUndefined();
  });
});

describe("input claims", () => {
  const seed = (p: P) => {
    fs.mkdirSync(inboxDir(p, "fe-member"), { recursive: true });
    sendFile(p, "lead", "fe-member", "job one");
    routeOutboxes(p);
    return listUnread(p, "fe-member");
  };

  it("marks input read only when the claim is committed, and finishes a half-done commit after a crash", () => {
    const p = bound();
    const msgs = seed(p);
    const claim = claimMessages(p.run!.dir, "fe-member", msgs);
    expect(listUnread(p, "fe-member")).toHaveLength(1); // claiming does not consume
    let step = 0;
    setFaultHook(() => {
      if (++step === 1) throw new Error("crash after the commit mark, before the move");
    });
    expect(() => commitClaim(p.run!.dir, claim.id)).toThrow(/crash/);
    setFaultHook(undefined);
    expect(loadClaim(p.run!.dir, claim.id).status).toBe("committed");
    expect(listUnread(p, "fe-member")).toHaveLength(1);
    const report = recoverRunMail(p.run!.dir);
    expect(report.finalized).toEqual([claim.id]);
    expect(listUnread(p, "fe-member")).toHaveLength(0); // committed mail is not woken again
  });

  it("leaves uncommitted input unread so it is handled again", () => {
    const p = bound();
    const claim = claimMessages(p.run!.dir, "fe-member", seed(p));
    const report = recoverRunMail(p.run!.dir);
    expect(report.abandoned.map((c) => c.id)).toEqual([claim.id]);
    expect(listUnread(p, "fe-member")).toHaveLength(1);
    expect(loadClaim(p.run!.dir, claim.id).status).toBe("abandoned");
  });
});

describe("dispatcher restart", () => {
  it("does not duplicate mail when the process dies while routing a lead's two-recipient task", async () => {
    env = makeEnv();
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-a");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    const mk =
      (log: string[]): Invoker =>
      async (i) => {
        log.push(i.agent.name);
        if (i.agent.name === "lead" && !i.userPrompt.includes("finished")) sendFile(i.project, "lead", ["fe-member", "qa-member"], "split job");
        else if (i.agent.name === "lead") sendFile(i.project, "lead", "lead", "all good", "done");
        else sendFile(i.project, i.agent.name, "lead", `${i.agent.name} finished`, "reply");
        return OK;
      };

    let step = 0;
    setFaultHook(() => {
      if (++step === 4) throw new Error("killed while routing");
    });
    await expect(runTeam({ project, task, runDir, invoker: mk([]), log: () => {} })).rejects.toThrow(/killed/);
    setFaultHook(undefined);

    const woken: string[] = [];
    const s = await runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, invoker: mk(woken), log: () => {} });
    const p = bindRunProject(env.project(), runDir, "run");
    expect(copies(p, "fe-member", "split job")).toHaveLength(1);
    expect(copies(p, "qa-member", "split job")).toHaveLength(1);
    expect(woken.filter((a) => a === "fe-member")).toHaveLength(1);
    // the lead goes first once a reply is in, so qa-member may never be woken before it ends; it must never be woken twice
    expect(woken.filter((a) => a === "qa-member").length).toBeLessThanOrEqual(1);
    expect(s.endReason).toBe("done");
  });
});

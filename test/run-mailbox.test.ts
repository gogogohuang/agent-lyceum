import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { deliver, listUnread, readMessage, routeOutboxes } from "../src/mailbox.js";
import { inboxDir, outboxDir, writePolicy } from "../src/policy.js";
import { bindRunProject, loadRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const send = (project: ReturnType<typeof bindRunProject>, from: string, to: string, subject: string, type = "reply", extra = "") =>
  write(path.join(outboxDir(project, from), `${Math.random()}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${extra}---\n\nbody\n`);

describe("run-scoped mailboxes", () => {
  it("keeps the unread mail of one run invisible to another run of the same project", () => {
    env = makeEnv();
    const base = env.project();
    const a = bindRunProject(base, path.join(base.paths.runs, "run-a"), "run");
    const b = bindRunProject(base, path.join(base.paths.runs, "run-b"), "run");
    deliver(a, { from: "user", to: "lead", type: "task", subject: "A's task", body: "x" });
    expect(listUnread(a, "lead")).toHaveLength(1);
    expect(listUnread(b, "lead")).toHaveLength(0);
    expect(listUnread(base, "lead")).toHaveLength(0);
    expect(inboxDir(a, "lead")).toBe(path.join(base.paths.runs, "run-a", "mail", "inbox", "lead"));
  });

  it("stamps the run id itself and rejects mail that claims another run", () => {
    env = makeEnv();
    const base = env.project();
    const a = bindRunProject(base, path.join(base.paths.runs, "run-a"), "run");
    fs.mkdirSync(path.join(inboxDir(a, "lead")), { recursive: true });
    send(a, "fe-member", "lead", "honest");
    send(a, "fe-member", "lead", "forged", "reply", "run_id: run-b\n");
    send(a, "fe-member", "lead", "own id", "reply", "run_id: run-a\n");
    const res = routeOutboxes(a);
    expect(res.delivered.map((d) => d.subject).sort()).toEqual(["honest", "own id"]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].reason).toMatch(/run-b/);
    for (const m of listUnread(a, "lead")) expect(readMessage(m.file).meta.run_id).toBe("run-a");
    // the sender is told why
    expect(listUnread(a, "fe-member").some((m) => m.meta.subject.includes("rejected"))).toBe(true);
  });

  it("lets an agent write only its own outbox of the run, and nothing else in the run dir or other runs", () => {
    env = makeEnv();
    const base = env.project();
    fs.mkdirSync(path.join(base.paths.runs, "other-run"), { recursive: true });
    const a = bindRunProject(base, path.join(base.paths.runs, "run-a"), "run");
    fs.mkdirSync(path.join(base.paths.runs, "run-a", "snapshots"), { recursive: true });
    const pol = writePolicy(a, a.agents["fe-member"]);
    const mine = outboxDir(a, "fe-member");
    expect(pol.allowDirs).toContain(mine);
    // no denied path may be the outbox or one of its parents (a deny on a parent would beat the allow)
    for (const d of pol.deny) expect(mine === d || mine.startsWith(d + path.sep)).toBe(false);
    expect(pol.deny).toContain(path.join(base.paths.runs, "other-run"));
    expect(pol.deny).toContain(path.join(base.paths.runs, "run-a", "snapshots"));
    expect(pol.deny).toContain(inboxDir(a, "lead"));
    expect(pol.deny).toContain(outboxDir(a, "lead"));
  });

  async function startTwoRoundRun(): Promise<string> {
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-a");
    const task = prepareTask({ text: "build it", cwd: env.root, runDir });
    const invoker: Invoker = async (i) => {
      if (i.agent.name === "lead") send(i.project, "lead", "fe-member", "job", "task");
      return OK;
    };
    env.editProjectYaml((t) => t.replace("max_rounds: 30", "max_rounds: 1"));
    const s = await runTeam({ project: env.project(), task, runDir, invoker, log: () => {} });
    expect(s.endReason).toBe("max_rounds");
    return runDir;
  }

  it("resumes a run on its own mailbox and keeps stamping its run id", async () => {
    env = makeEnv();
    const runDir = await startTwoRoundRun();
    expect(fs.existsSync(path.join(runDir, "mail", "inbox", "fe-member"))).toBe(true);
    const state = loadRunState(runDir);
    expect(state.mail_layout).toBe("run");
    expect(env.project().paths.inboxRoot).not.toContain("run-a");
    expect(listUnread(env.project(), "fe-member")).toHaveLength(0); // nothing leaked into the shared inbox

    env.editProjectYaml((t) => t.replace("max_rounds: 1", "max_rounds: 10"));
    const seen: string[] = [];
    const s = await runTeam({
      project: env.project(),
      resume: loadRunState(runDir),
      runDir,
      invoker: async (i) => {
        seen.push(i.agent.name);
        if (i.agent.name === "fe-member") send(i.project, "fe-member", "lead", "finished");
        else send(i.project, "lead", "lead", "all good", "done");
        return OK;
      },
      log: () => {},
    });
    expect(seen[0]).toBe("fe-member");
    expect(s.rounds).toBeGreaterThan(1);
    const read = fs.readdirSync(path.join(runDir, "mail", "inbox", "lead", "read"));
    expect(read.length).toBeGreaterThan(0);
    expect(readMessage(path.join(runDir, "mail", "inbox", "lead", "read", read[0])).meta.run_id).toBe("run-a");
  });

  it("keeps a legacy run on the shared mailbox and never moves its mail", async () => {
    env = makeEnv();
    const base = env.project();
    const runDir = path.join(base.paths.runs, "old-run");
    write(
      path.join(runDir, "state.json"),
      JSON.stringify({ run_id: "old-run", project: base.name, rounds: 1, max_rounds: 10, end_reason: "idle", last_wake: {}, wakes: [] }),
    );
    deliver(base, { from: "lead", to: "fe-member", type: "task", subject: "left behind", body: "x" });
    const seen: string[] = [];
    await runTeam({
      project: env.project(),
      resume: loadRunState(runDir),
      runDir,
      invoker: async (i) => {
        seen.push(`${i.agent.name}:${i.userPrompt.includes("left behind")}`);
        return OK;
      },
      log: () => {},
    });
    expect(seen).toEqual(["fe-member:true"]);
    expect(fs.existsSync(path.join(runDir, "mail", "inbox"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "mail", "outbox"))).toBe(false);
    expect(loadRunState(runDir).mail_layout).toBe("legacy");
  });
});

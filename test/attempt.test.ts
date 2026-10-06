import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { deliver, listUnread } from "../src/mailbox.js";
import { beginAttempt, claimMessages, loadAttempt, mailDir } from "../src/message-store.js";
import { inboxDir, outboxDir } from "../src/policy.js";
import { bindRunProject, loadRunState, newRunState, saveRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const FAIL: WakeResult = { ok: false, text: "", exitCode: 1, timedOut: false, error: "boom" };
const send = (p: Parameters<typeof outboxDir>[0], from: string, to: string, subject: string, type = "reply") =>
  write(path.join(outboxDir(p, from), `${subject.replace(/\W+/g, "-")}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n---\n\nbody of ${subject}\n`);
const subjectsIn = (dir: string) =>
  (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith(".md")).map((f) => /subject: (.*)/.exec(fs.readFileSync(path.join(dir, f), "utf8"))![1]);
const allMail = (p: Parameters<typeof inboxDir>[0], agent: string) => [...subjectsIn(inboxDir(p, agent)), ...subjectsIn(path.join(inboxDir(p, agent), "read"))];
const attemptsOf = (runDir: string) => {
  const dir = path.join(mailDir(runDir), "attempts");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
};

async function start(invoker: Invoker) {
  env = makeEnv();
  const project = env.project();
  const runDir = path.join(project.paths.runs, "run-a");
  const task = prepareTask({ text: "go", cwd: env.root, runDir });
  const s = await runTeam({ project, task, runDir, invoker, log: () => {} });
  return { s, runDir, bound: bindRunProject(env.project(), runDir, "run") };
}

describe("attempts", () => {
  it("keeps a failed attempt's output out of the retry's result and says side effects may have happened", async () => {
    let feCalls = 0;
    const { s, runDir, bound } = await start(async (i) => {
      if (i.agent.name === "lead" && !i.userPrompt.includes("fe done")) send(i.project, "lead", "fe-member", "job", "task");
      else if (i.agent.name === "lead") send(i.project, "lead", "lead", "all good", "done");
      else {
        feCalls++;
        if (feCalls === 1) {
          send(i.project, "fe-member", "lead", "stale half result");
          return FAIL;
        }
        expect(i.userPrompt).toMatch(/previous attempt .* failed/i);
        send(i.project, "fe-member", "lead", "fe done");
        return OK;
      }
      return OK;
    });
    expect(s.endReason).toBe("done");
    expect(allMail(bound, "lead")).toContain("fe done");
    expect(allMail(bound, "lead")).not.toContain("stale half result");

    const att = attemptsOf(runDir).filter((a) => a.agent === "fe-member");
    expect(att.map((a) => a.status)).toEqual(["failed", "committed"]);
    expect(att[0].id).toMatch(/-a1$/);
    expect(att[1].id).toMatch(/-a2$/);
    const parked = path.join(mailDir(runDir), "attempts", att[0].id, "outbox");
    expect(subjectsIn(parked)).toEqual(["stale half result"]);

    const notes = loadRunState(runDir).notes ?? [];
    expect(notes.join("\n")).toMatch(/fe-member.*attempt 1 failed.*side effects/i);
  });

  it("does not route any output of an agent whose every attempt failed, and tells the lead", async () => {
    const { s, runDir, bound } = await start(async (i) => {
      if (i.agent.name === "lead" && !i.userPrompt.includes("fe-member failed")) send(i.project, "lead", "fe-member", "job", "task");
      else if (i.agent.name === "lead") send(i.project, "lead", "lead", "gave up", "done");
      else {
        send(i.project, "fe-member", "lead", `junk from ${i.sessionId ?? "attempt"} ${Math.random()}`);
        return FAIL;
      }
      return OK;
    });
    expect(s.endReason).toBe("done");
    expect(allMail(bound, "lead").some((m) => m.startsWith("junk"))).toBe(false);
    expect(allMail(bound, "lead").some((m) => m.includes("fe-member failed"))).toBe(true);
    expect(attemptsOf(runDir).filter((a) => a.agent === "fe-member").every((a) => a.status === "failed")).toBe(true);
  });

  it("on resume, sets aside what an interrupted attempt left, redoes the message, and warns about side effects", async () => {
    env = makeEnv();
    const base = env.project();
    const runDir = path.join(base.paths.runs, "run-a");
    const p = bindRunProject(base, runDir, "run");
    fs.mkdirSync(runDir, { recursive: true });
    saveRunState(runDir, newRunState({ run_id: "run-a", project: base.name, max_rounds: 10, rounds: 1, pid: 1, task_summary: "t", active: { "fe-member": { round: 1, since: new Date().toISOString(), handling: [] } } }));
    deliver(p, { from: "lead", to: "fe-member", type: "task", subject: "job", body: "x" });
    const claim = claimMessages(runDir, "fe-member", listUnread(p, "fe-member"));
    const attempt = beginAttempt(runDir, claim.id);
    expect(attempt.status).toBe("started");
    send(p, "fe-member", "lead", "half written result");

    const woken: string[] = [];
    const s = await runTeam({
      project: env.project(),
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      invoker: async (i) => {
        woken.push(i.agent.name);
        if (i.agent.name === "fe-member") send(i.project, "fe-member", "lead", "redone result");
        else send(i.project, "lead", "lead", "all good", "done");
        return OK;
      },
    });
    expect(s.endReason).toBe("done");
    expect(woken[0]).toBe("fe-member");
    expect(allMail(p, "lead")).toContain("redone result");
    expect(allMail(p, "lead")).not.toContain("half written result");
    expect(loadAttempt(runDir, attempt.id).status).toBe("failed");
    expect(subjectsIn(path.join(mailDir(runDir), "attempts", attempt.id, "outbox"))).toEqual(["half written result"]);
    expect((loadRunState(runDir).notes ?? []).join("\n")).toMatch(/interrupted.*side effects/i);
  });
});

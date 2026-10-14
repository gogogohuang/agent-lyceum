import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { outboxDir } from "../src/policy.js";
import { loadRunState, saveRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { FULL_DONE, makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const send = (i: WakeInput, to: string, type: string, subject: string, body?: string) =>
  write(
    path.join(outboxDir(i.project, i.agent.name), `${Date.now()}-${Math.random()}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${body ?? (type === "done" ? FULL_DONE.replace("Shipped.", subject) : `body of ${subject}`)}\n`,
  );
/** The lead answers its first wake-up with a done report. */
const leadDone = (text: string): Invoker => async (i) => {
  send(i, i.agent.name, "done", text);
  return OK;
};
const first = async (invoker: Invoker) => {
  const project = env.project();
  const runDir = path.join(project.paths.runs, "run-1");
  const task = prepareTask({ text: "Build login", cwd: env.root, runDir });
  const summary = await runTeam({ project, task, runDir, log: () => {}, invoker });
  return { project, runDir, summary };
};

describe("reopening a done run", () => {
  it("mails the follow-up to the lead and ends done again, keeping every done report", async () => {
    env = makeEnv();
    const { project, runDir, summary } = await first(leadDone("first result"));
    expect(summary.endReason).toBe("done");
    expect(fs.readFileSync(path.join(runDir, "done-1.md"), "utf8")).toContain("first result");
    let seen = "";
    const second = await runTeam({
      project,
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      followup: { text: "Also add rate limiting" },
      invoker: async (i) => {
        seen = i.userPrompt;
        send(i, i.agent.name, "done", "second result");
        return OK;
      },
    });
    expect(second.endReason).toBe("done");
    expect(seen).toContain("Also add rate limiting");
    expect(seen).toContain(path.join(runDir, "done-1.md")); // the Upstream pointer names a file that exists
    const st = loadRunState(runDir);
    expect(st.reopened).toHaveLength(1);
    expect(st.round_floor).toBe(1);
    expect(fs.readFileSync(path.join(runDir, "followups", "1.md"), "utf8")).toContain("Also add rate limiting");
    expect(fs.readFileSync(path.join(runDir, "done-1.md"), "utf8")).toContain("first result");
    expect(fs.readFileSync(path.join(runDir, "done-2.md"), "utf8")).toContain("second result");
    expect(fs.readFileSync(path.join(runDir, "result.md"), "utf8")).toContain("second result");
  });

  it("counts the round limit from the reopen, so a run that used all its rounds can be reopened", async () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("max_rounds: 30", "max_rounds: 2"));
    // segment 1: the lead's first attempt fails (round 1), the retry reports done (round 2): both rounds used
    let n = 0;
    const { project, runDir, summary } = await first(async (i) => {
      if (++n === 1) return { ...OK, ok: false, exitCode: 1, error: "boom" };
      send(i, i.agent.name, "done", "first result");
      return OK;
    });
    expect(summary.endReason).toBe("done");
    expect(summary.rounds).toBe(2);
    expect(loadRunState(runDir).max_rounds).toBe(2);

    let m = 0;
    const second = await runTeam({
      project,
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      followup: { text: "More please" },
      invoker: async (i) => {
        if (++m === 1) return { ...OK, ok: false, exitCode: 1, error: "boom" };
        send(i, i.agent.name, "done", "second result");
        return OK;
      },
    });
    // the second segment gets its own 2 rounds (3 and 4); without the floor it would stop at once
    expect(second.endReason).toBe("done");
    expect(second.rounds).toBe(4);
    const st = loadRunState(runDir);
    expect(st.round_floor).toBe(2);
    expect(st.max_rounds).toBe(4);
  });

  it("refuses a follow-up on a run that is not done", async () => {
    env = makeEnv();
    const { project, runDir } = await first(leadDone("x"));
    const st = loadRunState(runDir);
    await expect(runTeam({ project, resume: { ...st, end_reason: "cancelled" }, runDir, followup: { text: "x" }, log: () => {}, invoker: async () => OK })).rejects.toThrow(/finished \(done\)/);
    await expect(runTeam({ project, runDir: path.join(project.paths.runs, "run-2"), task: prepareTask({ text: "t", cwd: env.root, runDir: path.join(project.paths.runs, "run-2") }), followup: { text: "x" }, log: () => {}, invoker: async () => OK })).rejects.toThrow(/finished \(done\)/);
  });

  it("a new run's limit is the configured one, and a plain resume keeps the reopen's floor", async () => {
    env = makeEnv();
    const { project, runDir } = await first(leadDone("first result"));
    const cfgMax = project.dispatcher.max_rounds;
    expect(loadRunState(runDir).max_rounds).toBe(cfgMax);
    await runTeam({ project, resume: loadRunState(runDir), runDir, log: () => {}, followup: { text: "again" }, invoker: leadDone("second result") });
    const reopened = loadRunState(runDir);
    expect(reopened.max_rounds).toBe(reopened.round_floor! + cfgMax);
    // cancelled mid-way, then resumed without a follow-up: the floor still applies
    saveRunState(runDir, { ...reopened, end_reason: "cancelled" });
    await runTeam({ project, resume: loadRunState(runDir), runDir, log: () => {}, invoker: leadDone("third result") }).catch(() => undefined);
    expect(loadRunState(runDir).max_rounds).toBe(reopened.round_floor! + cfgMax);
  });
});

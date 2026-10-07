import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeResult } from "../src/adapters/index.js";
import { runTeam, type RunSummary } from "../src/dispatcher.js";
import { doneContract } from "../src/format.js";
import { outboxDir } from "../src/policy.js";
import { loadRunState, outcomeOf } from "../src/run-store.js";
import { exitCodeForOutcome, RUN_OUTCOMES } from "../src/schema.js";
import { formatTaskList } from "../src/status.js";
import { prepareTask } from "../src/task.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const FULL = "## Result\nShipped login.\n\n## Files\n- src/login.ts\n\n## Verification\nnpm test: 12 passed\n\n## Not done\nNone\n";

const sendDone = (i: Parameters<Invoker>[0], fm: string, body: string) =>
  write(path.join(outboxDir(i.project, "lead"), `${Math.random()}.md`), `---\ntype: done\nsubject: report\n${fm}---\n\n${body}\n`);
const sendTask = (i: Parameters<Invoker>[0]) =>
  write(path.join(outboxDir(i.project, "lead"), `${Math.random()}.md`), `---\nto: fe-member\ntype: task\nsubject: job\n---\n\n## Goal\nx\n`);

async function run(invoker: Invoker): Promise<RunSummary> {
  env = makeEnv();
  const project = env.project();
  const runDir = path.join(project.paths.runs, "run-a");
  const task = prepareTask({ text: "go", cwd: env.root, runDir });
  return runTeam({ project, task, runDir, invoker, log: () => {} });
}

describe("exit codes", () => {
  it("only completed is success", () => {
    expect(RUN_OUTCOMES.map((o) => [o, exitCodeForOutcome(o)])).toEqual([
      ["completed", 0],
      ["partial", 2],
      ["blocked", 2],
      ["failed", 1],
      ["cancelled", 130],
    ]);
  });
});

describe("completion contract", () => {
  it("accepts a full completed report", () => {
    const c = doneContract({ outcome: "completed" }, FULL);
    expect(c.missing).toEqual([]);
    expect(c.outcome).toBe("completed");
    expect(c.verification).toBe("npm test: 12 passed");
  });

  it("names every gap: missing outcome, headings, unfinished steps", () => {
    expect(doneContract({}, FULL).missing.join(" ")).toMatch(/outcome/);
    expect(doneContract({ outcome: "completed" }, "## Result\nok\n").missing.join(" ")).toMatch(/Files.*Verification.*Not done/);
    expect(doneContract({ outcome: "completed" }, FULL + "\n## Steps\n- [x] a\n- [ ] build\n").missing.join(" ")).toMatch(/build/);
    expect(doneContract({ outcome: "completed" }, FULL, [{ text: "deploy", done: false }]).missing.join(" ")).toMatch(/deploy/);
    expect(doneContract({ outcome: "cancelled" }, FULL).missing.join(" ")).toMatch(/outcome/);
  });

  it("asks less of a report that admits it is not complete", () => {
    expect(doneContract({ outcome: "blocked" }, "## Result\nstuck on X\n\n## Not done\nall of it\n")).toMatchObject({ missing: [], outcome: "blocked" });
    expect(doneContract({ outcome: "partial" }, "## Result\nhalf\n").missing.join(" ")).toMatch(/Not done/);
  });
});

describe("run outcome", () => {
  it("is completed, and exit-0 material, only for a full completed done", async () => {
    const s = await run(async (i) => {
      sendDone(i, "outcome: completed\n", FULL);
      return OK;
    });
    expect(s.endReason).toBe("done");
    expect(s.outcome).toBe("completed");
    const st = loadRunState(s.runDir);
    expect(st.outcome).toBe("completed");
    expect(st.verification).toBe("npm test: 12 passed");
    expect(fs.readFileSync(path.join(s.runDir, "result.md"), "utf8")).toMatch(/^# report\n\n\*\*Outcome:\*\* completed\n/);
  });

  it("is partial when the lead stops without ever sending done (idle)", async () => {
    const s = await run(async () => OK);
    expect(s.endReason).toBe("idle");
    expect(s.outcome).toBe("partial");
    expect(exitCodeForOutcome(s.outcome)).toBe(2);
  });

  it("is failed when the lead itself fails", async () => {
    const s = await run(async () => ({ ...OK, ok: false, error: "boom" }));
    expect(s.endReason).toBe("lead_failed");
    expect(s.outcome).toBe("failed");
    expect(exitCodeForOutcome(s.outcome)).toBe(1);
  });

  it("is partial at the round limit", async () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("max_rounds: 30", "max_rounds: 2"));
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-a");
    const s = await runTeam({ project, task: prepareTask({ text: "go", cwd: env.root, runDir }), runDir, log: () => {}, invoker: async (i) => {
        if (i.agent.name === "lead") sendTask(i);
        else write(path.join(outboxDir(i.project, "fe-member"), "r.md"), "---\nto: lead\ntype: reply\nsubject: back\n---\n\nx\n");
        return OK;
      } });
    expect(s.endReason).toBe("max_rounds");
    expect(s.outcome).toBe("partial");
  });

  it("keeps a blocked report as blocked", async () => {
    const s = await run(async (i) => {
      sendDone(i, "outcome: blocked\n", "## Result\nneed credentials\n\n## Not done\neverything\n");
      return OK;
    });
    expect(s.endReason).toBe("done");
    expect(s.outcome).toBe("blocked");
    expect(exitCodeForOutcome(s.outcome)).toBe(2);
  });

  it("sends a done that breaks the contract back to the lead, and ends when the fix arrives", async () => {
    const seen: string[] = [];
    const s = await run(async (i) => {
      seen.push(i.userPrompt.includes("done report was not accepted") ? "retry" : "first");
      if (seen.length === 1) sendDone(i, "", "all good, trust me");
      else sendDone(i, "outcome: completed\n", FULL);
      return OK;
    });
    expect(seen).toEqual(["first", "retry"]);
    expect(s.outcome).toBe("completed");
    const rejected = fs.readdirSync(path.join(s.runDir, "mail", "outbox", "lead", "rejected"));
    expect(rejected).toHaveLength(1);
    expect(loadRunState(s.runDir).done_rejections).toBe(1);
  });

  it("will not take 'completed' from a done with unfinished steps", async () => {
    const seen: number[] = [];
    const s = await run(async (i) => {
      seen.push(1);
      sendDone(i, "outcome: completed\n", seen.length === 1 ? FULL + "\n## Steps\n- [x] build\n- [ ] deploy\n" : FULL + "\n## Steps\n- [x] build\n- [x] deploy\n");
      return OK;
    });
    expect(seen).toHaveLength(2);
    expect(s.outcome).toBe("completed");
  });

  it("gives up after two reminders: the report is kept, the outcome is partial and the gap is recorded", async () => {
    let calls = 0;
    const s = await run(async (i) => {
      calls++;
      sendDone(i, "", `## Result\nattempt ${calls}\n`);
      return OK;
    });
    expect(calls).toBe(3);
    expect(s.endReason).toBe("done");
    expect(s.outcome).toBe("partial");
    const st = loadRunState(s.runDir);
    expect(st.outcome_note).toMatch(/contract/i);
    expect(fs.readFileSync(path.join(s.runDir, "result.md"), "utf8")).toContain("attempt 3");
  });
});

describe("legacy runs", () => {
  it("never count as successful: a finished run without an outcome reads as partial and unverified", () => {
    env = makeEnv();
    const dir = path.join(env.project().paths.runs, "20260102-000000");
    write(path.join(dir, "state.json"), JSON.stringify({ run_id: "20260102-000000", rounds: 3, max_rounds: 10, last_wake: {}, wakes: [], end_reason: "done", task_summary: "Ship it" }));
    const st = loadRunState(dir);
    expect(outcomeOf(st)).toEqual({ outcome: "partial", verified: false });
    expect(st.end_reason).toBe("done"); // original information kept
    expect(formatTaskList(env.project())).toContain("已結束：完成（未驗證）");
  });
});

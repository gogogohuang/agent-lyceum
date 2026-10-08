import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeResult } from "../src/adapters/index.js";
import { askReplyPath, readAskReply, writeAskReply } from "../src/ask-reply.js";
import { runTeam } from "../src/dispatcher.js";
import { listUnread } from "../src/mailbox.js";
import { outboxDir } from "../src/policy.js";
import { bindRunProject, loadRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { FULL_DONE, makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const ASK = (id = "q1", text = "JWT?") => `<ask><question id="${id}"><text>${text}</text><options><option>session</option><option>jwt</option></options><suggested>session</suggested></question></ask>`;

function mail(project: ReturnType<typeof bindRunProject>, from: string, type: string, body: string, to = "lead") {
  write(path.join(outboxDir(project, from), `${Math.random()}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: ${type}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${body}\n`);
}

/** Runs with a scripted invoker: step i is what the i-th wake-up does. */
function scripted(steps: ((agent: string, project: ReturnType<typeof bindRunProject>) => void)[]): { invoker: Invoker; woken: string[] } {
  const woken: string[] = [];
  let i = 0;
  const invoker: Invoker = async (input) => {
    woken.push(input.agent.name);
    steps[i++]?.(input.agent.name, input.project as ReturnType<typeof bindRunProject>);
    return OK;
  };
  return { invoker, woken };
}

function start(invoker: Invoker, runId = "run-a") {
  const project = env.project();
  const runDir = path.join(project.paths.runs, runId);
  const task = prepareTask({ text: "build it", cwd: env.root, runDir });
  return { project, runDir, run: () => runTeam({ project, task, runDir, invoker, log: () => {} }) };
}
const resume = (project: ReturnType<typeof env.project>, runDir: string, invoker: Invoker) =>
  runTeam({ project, resume: loadRunState(runDir), runDir, invoker, log: () => {} });

describe("ask → waiting", () => {
  it("ends the run as waiting after the lead's ask, writes ask-reply.md and does not use up a round", async () => {
    env = makeEnv();
    const { invoker, woken } = scripted([(a, p) => mail(p, a, "ask", ASK())]);
    const { runDir, run } = start(invoker);
    const s = await run();
    expect(s.endReason).toBe("waiting");
    expect(s.outcome).toBe("waiting");
    expect(s.askReplyPath).toBe(askReplyPath(runDir));
    expect(woken).toEqual(["lead"]);
    expect(s.rounds).toBe(1); // the lead's own wake-up counts; waiting adds none
    const r = readAskReply(runDir)!;
    expect(r.status).toBe("pending");
    expect(r.questions.map((q) => [q.id, q.asker])).toEqual([["q1", "lead"]]);
    const st = loadRunState(runDir);
    expect(st.end_reason).toBe("waiting");
    expect(st.outcome).toBe("waiting");
  });

  it("keeps every other mailbox intact so resume can continue", async () => {
    env = makeEnv();
    const { invoker } = scripted([(a, p) => mail(p, a, "ask", ASK())]);
    const { project, runDir, run } = start(invoker);
    await run();
    const bound = bindRunProject(project, runDir, "run");
    expect(listUnread(bound, "lead")).toHaveLength(0); // the task was consumed, the ask was taken from the outbox
    expect(fs.readdirSync(outboxDir(bound, "lead")).filter((f) => f.endsWith(".md"))).toEqual([]);
  });

  it("rejects an ask from a member without can_ask_user and tells the member to go through the lead", async () => {
    env = makeEnv();
    const REPLY = "## Changes\nNone\n\n## Verification\nNone\n\n## Open items\nNone\n\n## Risks\nNone";
    const prompts: string[] = [];
    const { invoker } = scripted([
      (a, p) => mail(p, a, "task", "## Goal\ng\n\n## Acceptance criteria\na\n\n## Scope\ns\n\n## Upstream\nNone", "fe-member"),
      (a, p) => mail(p, a, "ask", ASK()),
      (a, p) => mail(p, a, "reply", REPLY),
      (a, p) => mail(p, a, "done", FULL_DONE),
    ]);
    const spy: Invoker = async (i) => {
      prompts.push(i.userPrompt);
      return invoker(i);
    };
    const { runDir, run } = start(spy);
    const s = await run();
    expect(s.endReason).toBe("done"); // never waiting: the member may not ask
    expect(prompts[2]).toMatch(/can_ask_user/);
    expect(fs.existsSync(askReplyPath(runDir))).toBe(false);
  });
});

describe("malformed ask", () => {
  it("sends it back twice, then reports a failure to the lead", async () => {
    env = makeEnv();
    const seen: string[] = [];
    const { invoker } = scripted([
      (a, p) => mail(p, a, "ask", "no xml"),
      (a, p) => mail(p, a, "ask", "still no xml"),
      (a, p) => mail(p, a, "ask", "nope"),
      (a, p) => mail(p, a, "done", FULL_DONE),
    ]);
    const wrapped: Invoker = async (i) => {
      seen.push(i.userPrompt);
      return invoker(i);
    };
    const { run } = start(wrapped);
    const s = await run();
    expect(s.endReason).toBe("done"); // never waiting: nothing valid was asked
    expect(seen[1]).toMatch(/ask was not accepted/);
    expect(seen[2]).toMatch(/ask was not accepted/);
    expect(seen[3]).toMatch(/rejected 3 times/);
  });
});

describe("resume from waiting", () => {
  async function waiting() {
    env = makeEnv();
    const first = scripted([(a, p) => mail(p, a, "ask", ASK())]);
    const s = start(first.invoker);
    await s.run();
    return s;
  }

  it("refuses while questions are unanswered and lists which", async () => {
    const { project, runDir } = await waiting();
    await expect(resume(project, runDir, scripted([]).invoker)).rejects.toThrow(/q1/);
    expect(loadRunState(runDir).end_reason).toBe("waiting"); // the refusal changed nothing
  });

  it("delivers the answers to the asker as a reply and finishes", async () => {
    const { project, runDir } = await waiting();
    const r = readAskReply(runDir)!;
    writeAskReply(runDir, { ...r, questions: r.questions.map((q) => ({ ...q, answer: { value: "jwt", by: "user" as const } })) });
    let prompt = "";
    const { invoker, woken } = scripted([(a, p) => mail(p, a, "done", FULL_DONE)]);
    const spy: Invoker = async (i) => {
      prompt = i.userPrompt;
      return invoker(i);
    };
    const s = await resume(project, runDir, spy);
    expect(s.endReason).toBe("done");
    expect(woken).toEqual(["lead"]);
    expect(prompt).toContain("<answers>");
    expect(prompt).toContain("jwt");
    const after = readAskReply(runDir)!;
    expect(after.status).toBe("answered");
    expect(after.questions[0]?.delivered).toBe(true);
  });

  it("a second ask keeps the first answers and only waits for the new question", async () => {
    const { project, runDir } = await waiting();
    const r = readAskReply(runDir)!;
    writeAskReply(runDir, { ...r, questions: r.questions.map((q) => ({ ...q, answer: { value: "jwt", by: "user" as const } })) });
    const second = scripted([(a, p) => mail(p, a, "ask", ASK("q2", "second?"))]);
    const s = await resume(project, runDir, second.invoker);
    expect(s.endReason).toBe("waiting");
    const again = readAskReply(runDir)!;
    expect(again.questions.map((q) => [q.id, q.delivered ?? false])).toEqual([["q1", true], ["q2", false]]);
    await expect(resume(project, runDir, scripted([]).invoker)).rejects.toThrow(/q2/);
  });
});

describe("runs without ask", () => {
  it("are unaffected: no ask-reply.md is created", async () => {
    env = makeEnv();
    const { invoker } = scripted([(a, p) => mail(p, a, "done", FULL_DONE)]);
    const { runDir, run } = start(invoker);
    const s = await run();
    expect(s.endReason).toBe("done");
    expect(fs.existsSync(askReplyPath(runDir))).toBe(false);
  });
});

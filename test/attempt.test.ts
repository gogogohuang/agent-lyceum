import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { deliver, listUnread } from "../src/mailbox.js";
import { attemptOutboxDir, beginAttempt, claimMessages, loadAttempt, mailDir } from "../src/message-store.js";
import { buildUserPrompt } from "../src/prompt.js";
import { inboxDir, outboxDir } from "../src/policy.js";
import { bindRunProject, loadRunState, newRunState, saveRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { FULL_DONE, withSections, makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const FAIL: WakeResult = { ok: false, text: "", exitCode: 1, timedOut: false, error: "boom" };
const send = (p: Parameters<typeof outboxDir>[0], from: string, to: string, subject: string, type = "reply") =>
  write(path.join(outboxDir(p, from), `${subject.replace(/\W+/g, "-")}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${type === "done" ? FULL_DONE : withSections(type, `body of ${subject}`)}\n`);
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

  it("stops the run when an agent fails on every call (the first and 2 more), routes none of its output, and keeps its message unread", async () => {
    let feCalls = 0;
    const { s, runDir, bound } = await start(async (i) => {
      if (i.agent.name === "lead") send(i.project, "lead", "fe-member", "job", "task");
      else {
        feCalls++;
        send(i.project, "fe-member", "lead", `junk ${Math.random()}`);
        return { ...FAIL, error: "boom" };
      }
      return OK;
    });
    expect(feCalls).toBe(3);
    expect(s.endReason).toBe("agent_failed");
    expect(s.outcome).toBe("failed");
    expect(s.failure).toEqual({ agent: "fe-member", error: "boom", attempts: 3 });
    expect(s.outcomeNote).toMatch(/fe-member failed 3 time\(s\).*boom/);
    expect(allMail(bound, "lead").some((m) => m.startsWith("junk"))).toBe(false);
    expect(listUnread(bound, "fe-member").map((m) => m.meta.subject)).toEqual(["job"]);
    expect(attemptsOf(runDir).filter((a) => a.agent === "fe-member").every((a) => a.status === "failed")).toBe(true);
    expect(loadRunState(runDir).failure?.agent).toBe("fe-member");
  });

  it("resuming a run stopped by a failing agent handles the same message again and clears the failure", async () => {
    let fail = true;
    const invoker: Invoker = async (i) => {
      if (i.agent.name === "lead") {
        if (i.userPrompt.includes("fe ok")) send(i.project, "lead", "lead", "all done", "done");
        else send(i.project, "lead", "fe-member", "job", "task");
        return OK;
      }
      if (fail) return { ...FAIL, error: "boom" };
      send(i.project, "fe-member", "lead", "fe ok");
      return OK;
    };
    const { s, runDir } = await start(invoker);
    expect(s.endReason).toBe("agent_failed");
    fail = false;
    const again = await runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, invoker, log: () => {} });
    expect(again.endReason).toBe("done");
    expect(again.failure).toBeUndefined();
    expect(loadRunState(runDir).failure).toBeUndefined();
  });

  it("has no round limit unless one is configured", async () => {
    let n = 0;
    const { s } = await start(async (i) => {
      if (i.agent.name === "lead") send(i.project, "lead", ++n > 20 ? "lead" : "fe-member", `step ${n}`, n > 20 ? "done" : "task");
      else send(i.project, "fe-member", "lead", `back ${n}`);
      return OK;
    });
    expect(s.rounds).toBeGreaterThan(30);
    expect(s.endReason).toBe("done");
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

const logEvents = (runDir: string, event: string) =>
  fs.readFileSync(path.join(runDir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === event);
const sendNamed = (p: Parameters<typeof outboxDir>[0], from: string, to: string, subject: string, body: string, type = "reply") =>
  write(path.join(outboxDir(p, from), `${subject.replace(/\W+/g, "-")}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n---\n\n${withSections(type, body)}\n`);
const MARK = `draft-marker-${crypto.randomBytes(4).toString("hex")}`;

/** A lead that hands one job to fe-member and finishes when it hears back. */
const leadFlow = (i: WakeInput): boolean => {
  if (i.agent.name !== "lead") return false;
  if (i.userPrompt.includes("fe finished")) send(i.project, "lead", "lead", "all good", "done");
  else send(i.project, "lead", "fe-member", "job", "task");
  return true;
};

describe("redo context", () => {
  it("T3: a retry in the same wake gets the failed attempt's draft and no 'discarded'", async () => {
    const prompts: string[] = [];
    const { s, runDir } = await start(async (i) => {
      if (leadFlow(i)) return OK;
      prompts.push(i.userPrompt);
      if (prompts.length === 1) {
        sendNamed(i.project, "fe-member", "lead", MARK, `${MARK} body`);
        return FAIL;
      }
      send(i.project, "fe-member", "lead", "fe finished");
      return OK;
    });
    expect(s.endReason).toBe("done");
    expect(prompts[0]).not.toMatch(/Retry notice|Redo notice/);
    expect(prompts[1]).toContain("Its mail was set aside, not delivered: see the drafts below.");
    expect(prompts[1]).not.toContain("discarded");
    expect(prompts[1]).toContain(`${MARK} body`);
    expect(logEvents(runDir, "redo")[0]).toMatchObject({ agent: "fe-member", notice: "retry" });
    expect(logEvents(runDir, "draft_inject")).toHaveLength(1);
  });

  it("T11: a draft is never delivered or journaled, and stays where it was set aside", async () => {
    const { s, runDir, bound } = await start(async (i) => {
      if (leadFlow(i)) return OK;
      if (i.userPrompt.includes("# Retry notice")) {
        send(i.project, "fe-member", "lead", "fe finished");
        return OK;
      }
      sendNamed(i.project, "fe-member", "lead", MARK, `body ${MARK}`);
      return FAIL;
    });
    expect(s.endReason).toBe("done");
    expect(allMail(bound, "lead").some((m) => m.includes(MARK))).toBe(false);
    for (const dir of [inboxDir(bound, "lead"), path.join(inboxDir(bound, "lead"), "read")])
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (f.endsWith(".md")) expect(fs.readFileSync(path.join(dir, f), "utf8")).not.toContain(MARK);
    const journal = fs.readFileSync(path.join(mailDir(runDir), "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ids = new Set(journal.filter((j) => j.t === "intent").map((j) => j.msg_id));
    const finished = [...subjectsIn(inboxDir(bound, "lead")), ...subjectsIn(path.join(inboxDir(bound, "lead"), "read"))];
    expect(finished).toContain("fe finished");
    // every journaled delivery belongs to a mail that is in an inbox; none is the draft's
    const mailIds = [inboxDir(bound, "lead"), path.join(inboxDir(bound, "lead"), "read"), inboxDir(bound, "fe-member"), path.join(inboxDir(bound, "fe-member"), "read")].flatMap((d) =>
      (fs.existsSync(d) ? fs.readdirSync(d) : []).filter((f) => f.endsWith(".md")).map((f) => ({ id: /id: (\S+)/.exec(fs.readFileSync(path.join(d, f), "utf8"))?.[1], text: fs.readFileSync(path.join(d, f), "utf8") })),
    );
    for (const id of ids) expect(mailIds.find((m) => m.id === id)?.text ?? "").not.toContain(MARK);
    const failed = attemptsOf(runDir).find((a) => a.status === "failed");
    const kept = path.join(mailDir(runDir), "attempts", failed.id, "outbox");
    expect(fs.readdirSync(kept)).toHaveLength(1);
    expect(fs.readFileSync(path.join(kept, fs.readdirSync(kept)[0]), "utf8")).toContain(`body ${MARK}`);
  });

  it("T4: a retry without a draft is the old text plus the task memory sentence", async () => {
    const prompts: { text: string; task?: string }[] = [];
    await start(async (i) => {
      if (leadFlow(i)) return OK;
      prompts.push({ text: i.userPrompt, task: i.agent.memory.task });
      if (prompts.length === 1) return FAIL;
      send(i.project, "fe-member", "lead", "fe finished");
      return OK;
    });
    const task = prompts[1]!.task;
    expect(task).toBeTruthy();
    const tail = "Check the current state of the repository before redoing the work, and send the mail again.";
    const g = ` Read your task memory (\`${task}\`) first: progress you recorded there survives a failed attempt.`;
    expect(prompts[1]!.text).toBe(`${prompts[0]!.text}\n\n# Retry notice\nYour previous attempt at this wake-up failed (boom) after possibly changing files already. Its mail was discarded. ${tail}${g}`);
  });

  it("T5: a first wake with nothing to redo gets exactly the plain prompt", async () => {
    const seen: { text: string; plain: string }[] = [];
    await start(async (i) => {
      if (leadFlow(i)) return OK;
      seen.push({ text: i.userPrompt, plain: buildUserPrompt(i.project, i.agent, listUnread(i.project, i.agent.name), 1) });
      send(i.project, "fe-member", "lead", "fe finished");
      return OK;
    });
    expect(seen[0]!.text).not.toMatch(/# (Retry|Redo) notice|Drafts from/);
    expect(seen[0]!.text).toBe(seen[0]!.plain);
    expect(logEvents(path.join(env.project().paths.runs, "run-a"), "redo")).toEqual([]);
  });

  it("T12: a damaged claim file only drops its own attempts; the wake goes on and the skip is logged", async () => {
    env = makeEnv();
    const base = env.project();
    const runDir = path.join(base.paths.runs, "run-a");
    const p = bindRunProject(base, runDir, "run");
    fs.mkdirSync(runDir, { recursive: true });
    saveRunState(runDir, newRunState({ run_id: "run-a", project: base.name, max_rounds: 10, rounds: 1, pid: 1, task_summary: "t" }));
    deliver(p, { from: "lead", to: "fe-member", type: "task", subject: "job", body: "x" });
    const msgs = listUnread(p, "fe-member");
    const good = claimMessages(runDir, "fe-member", msgs);
    const goodAttempt = beginAttempt(runDir, good.id);
    // the draft is parked under goodAttempt directly, so claim-id ordering cannot decide which attempt owns it
    write(
      path.join(attemptOutboxDir(runDir, goodAttempt.id), "good-half.md"),
      `---\nto: lead\ntype: reply\nsubject: good half\n---\n\n${withSections("reply", "GOOD-DRAFT")}\n`,
    );
    const bad = claimMessages(runDir, "fe-member", msgs);
    const badAttempt = beginAttempt(runDir, bad.id);
    // both attempts die with a hard kill; the second claim's file is then damaged
    const prompts: string[] = [];
    fs.writeFileSync(path.join(mailDir(runDir), "claims", `${bad.id}.json`), "{ broken");
    void badAttempt;
    const s = await runTeam({
      project: env.project(),
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      invoker: async (i) => {
        if (i.agent.name === "fe-member") {
          prompts.push(i.userPrompt);
          send(i.project, "fe-member", "lead", "fe finished");
        } else leadFlow(i);
        return OK;
      },
    });
    expect(s.endReason).toBe("done");
    expect(prompts[0]).toContain("GOOD-DRAFT");
    const skip = logEvents(runDir, "draft_skip").find((e) => e.path === `mail/claims/${bad.id}.json`);
    expect(skip).toMatchObject({ reason: "metadata_unreadable" });
    expect(logEvents(runDir, "redo")[0]?.prior).toEqual([goodAttempt.id]);
  });

  it("T1: after a hard kill, the resumed attempt is told to redo and gets the draft", async () => {
    env = makeEnv();
    const base = env.project();
    const runDir = path.join(base.paths.runs, "run-a");
    const p = bindRunProject(base, runDir, "run");
    fs.mkdirSync(runDir, { recursive: true });
    saveRunState(runDir, newRunState({ run_id: "run-a", project: base.name, max_rounds: 10, rounds: 1, pid: 1, task_summary: "t", active: { "fe-member": { round: 1, since: new Date().toISOString(), handling: [] } } }));
    deliver(p, { from: "lead", to: "fe-member", type: "task", subject: "job", body: "x" });
    const claim = claimMessages(runDir, "fe-member", listUnread(p, "fe-member"));
    const attempt = beginAttempt(runDir, claim.id);
    sendNamed(p, "fe-member", "lead", "half", `HALF-${MARK}`);
    const prompts: string[] = [];
    const s = await runTeam({
      project: env.project(),
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      invoker: async (i) => {
        if (i.agent.name === "fe-member") {
          prompts.push(i.userPrompt);
          send(i.project, "fe-member", "lead", "fe finished");
        } else leadFlow(i);
        return OK;
      },
    });
    expect(s.endReason).toBe("done");
    expect(prompts[0]).toContain("# Redo notice");
    expect(prompts[0]).toContain(`(interrupted; attempt ${attempt.id})`);
    expect(prompts[0]).toContain(`HALF-${MARK}`);
    expect(prompts[0]).toContain("# Drafts from your failed attempt");
    expect(logEvents(runDir, "redo")[0]).toMatchObject({ notice: "redo", prior: [attempt.id] });
    expect(logEvents(runDir, "wake").find((w) => w.agent === "fe-member")?.redo_of).toEqual([attempt.id]);
  });

  it("T2: after a graceful cancel, the resumed attempt is told it was cancelled and gets the draft", async () => {
    const ac = new AbortController();
    env = makeEnv();
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-a");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    const first = await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      signal: ac.signal,
      invoker: async (i) => {
        if (leadFlow(i)) return OK;
        sendNamed(i.project, "fe-member", "lead", "half", `CANCELLED-${MARK}`);
        ac.abort();
        return { ...FAIL, cancelled: true, error: "cancelled" };
      },
    });
    expect(first.endReason).not.toBe("done");
    const prompts: string[] = [];
    const again = await runTeam({
      project: env.project(),
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      invoker: async (i) => {
        if (i.agent.name === "fe-member") {
          prompts.push(i.userPrompt);
          send(i.project, "fe-member", "lead", "fe finished");
        } else leadFlow(i);
        return OK;
      },
    });
    expect(again.endReason).toBe("done");
    expect(prompts[0]).toContain("# Redo notice");
    expect(prompts[0]).toContain("cancelled");
    expect(prompts[0]).toContain(`CANCELLED-${MARK}`);
  });
});

describe("a draft is handed back whatever the session state (T17)", () => {
  const timedOut: WakeResult = { ok: false, text: "", exitCode: null, timedOut: true, error: "timed out" };
  const runWith = async (resume: boolean, firstResult: WakeResult) => {
    env = makeEnv();
    const project = env.project();
    project.agents["fe-member"]!.resume = resume;
    const runDir = path.join(project.paths.runs, "run-a");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    const calls: WakeInput[] = [];
    await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      invoker: async (i) => {
        if (leadFlow(i)) return OK;
        calls.push(i);
        if (calls.length === 1) {
          sendNamed(i.project, "fe-member", "lead", MARK, `T17-${MARK}`);
          return firstResult;
        }
        send(i.project, "fe-member", "lead", "fe finished");
        return OK;
      },
    });
    return calls;
  };

  it("(b) resume: false, the failed call returned a session id: the retry has no session but still has the draft", async () => {
    const calls = await runWith(false, { ...FAIL, sessionId: "S1" });
    expect(calls[1]!.sessionId).toBeUndefined();
    expect(calls[1]!.userPrompt).toContain(`T17-${MARK}`);
    expect(calls[1]!.userPrompt).toContain("# Retry notice");
  });

  it("(a) resume: true and a timeout without a session id: the retry resumes the earlier session and still has the draft", async () => {
    env = makeEnv();
    const project = env.project();
    project.agents["fe-member"]!.resume = true;
    const runDir = path.join(project.paths.runs, "run-a");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    const calls: WakeInput[] = [];
    // The first call has no session; the lead's wake saves S0 for the member only after a successful call, so seed it by a first good wake.
    let feCalls = 0;
    await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      invoker: async (i) => {
        if (i.agent.name === "lead") {
          if (i.userPrompt.includes("fe finished")) send(i.project, "lead", "lead", "all good", "done");
          else send(i.project, "lead", "fe-member", feCalls === 0 ? "job" : "job two", "task");
          return OK;
        }
        calls.push(i);
        feCalls++;
        if (feCalls === 1) {
          send(i.project, "fe-member", "lead", "first ok");
          return { ...OK, sessionId: "S0" };
        }
        if (feCalls === 2) {
          sendNamed(i.project, "fe-member", "lead", MARK, `T17-${MARK}`);
          return timedOut;
        }
        send(i.project, "fe-member", "lead", "fe finished");
        return OK;
      },
    });
    expect(calls[1]!.sessionId).toBe("S0");
    expect(calls[2]!.sessionId).toBe("S0");
    expect(calls[2]!.userPrompt).toContain(`T17-${MARK}`);
  });
});

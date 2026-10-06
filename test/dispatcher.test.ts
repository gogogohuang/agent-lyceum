import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import { runTeam, type RunSummary } from "../src/dispatcher.js";
import { ProtectedGuard } from "../src/guard.js";
import { bindRunProject } from "../src/run-store.js";
import { inboxDir, outboxDir } from "../src/policy.js";
import { prepareTask, readTaskFile, TASK_FILE_MAX, TASK_INLINE_MAX } from "../src/task.js";
import { FULL_DONE, initGitRepo, makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const mail = (i: WakeInput, to: string, subject: string, type = "reply") =>
  write(path.join(outboxDir(i.project, i.agent.name), `${Date.now()}-${Math.random()}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${type === "done" ? FULL_DONE : `body of ${subject}`}\n`);

async function run(invoker: Invoker, opts: { task?: string; file?: string } = {}): Promise<RunSummary> {
  const project = env.project();
  const runDir = path.join(project.paths.runs, "run-1");
  const task = prepareTask({ text: opts.task ?? "build the thing", file: opts.file, cwd: env.root, runDir });
  return runTeam({ project, task, runDir, invoker, log: () => {} });
}

const events = (runDir: string) =>
  fs.readFileSync(path.join(runDir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("dispatcher", () => {
  it("routes a task lead -> fe-member -> lead and ends on done", async () => {
    env = makeEnv();
    const seen: string[] = [];
    const s = await run(async (i) => {
      seen.push(i.agent.name);
      if (i.agent.name === "lead" && seen.length === 1) mail(i, "fe-member", "implement login", "task");
      else if (i.agent.name === "fe-member") mail(i, "lead", "login implemented");
      else if (i.agent.name === "lead") mail(i, "lead", "all good", "done");
      return OK;
    });
    expect(seen).toEqual(["lead", "fe-member", "lead"]);
    expect(s.endReason).toBe("done");
    expect(s.rounds).toBe(3);
    expect(s.doneMessage?.subject).toBe("all good");
    expect(fs.readFileSync(path.join(s.runDir, "result.md"), "utf8")).toMatch(/^# all good\n/);
    const state = JSON.parse(fs.readFileSync(path.join(s.runDir, "state.json"), "utf8"));
    expect(state.end_reason).toBe("done");
    expect(state.task_source).toBe("text");
    expect(fs.readFileSync(path.join(s.runDir, "task.md"), "utf8")).toContain("build the thing");
    expect(events(s.runDir).filter((e) => e.event === "wake")).toHaveLength(3);
  });

  it("records handoffs, message briefs and the lead's Steps checklist in state.json", async () => {
    env = makeEnv();
    const s = await run(async (i) => {
      const out = outboxDir(i.project, i.agent.name);
      const send = (to: string, type: string, subject: string, body: string) =>
        write(path.join(out, `${Math.random()}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${body}\n`);
      if (i.agent.name === "lead" && !i.userPrompt.includes("from: fe-member"))
        send("fe-member", "task", "implement login", "## Goal\nBuild the login form\n\n## Steps\n- [x] design\n- [ ] build\n");
      else if (i.agent.name === "fe-member") send("lead", "reply", "login implemented", "## Changes\n- added login.ts\n");
      else send("lead", "done", "all good", `${FULL_DONE}\n## Steps\n- [x] design\n- [x] build\n`);
      return OK;
    }, { task: "ship login\n\n- [ ] design\n- [ ] build" });
    const state = JSON.parse(fs.readFileSync(path.join(s.runDir, "state.json"), "utf8"));
    expect(state.wakes[0].sent).toEqual([{ to: "fe-member", type: "task", subject: "implement login" }]);
    expect(state.wakes[1].handling[0].brief).toBe("Build the login form");
    expect(state.wakes[1].sent[0].to).toBe("lead");
    expect(state.wakes[2].handling[0].brief).toBe("added login.ts");
    expect(state.wakes[2].sent).toEqual([{ to: "(done)", type: "done", subject: "all good" }]);
    expect(state.steps).toEqual([
      { text: "design", done: true },
      { text: "build", done: true },
    ]);
  });

  it("handles the oldest message first and keeps the rest unread for later wake-ups", async () => {
    env = makeEnv();
    const prompts: string[] = [];
    let first = true;
    await run(async (i) => {
      if (i.agent.name === "lead" && first) {
        first = false;
        mail(i, "fe-member", "older job", "task");
        mail(i, "fe-member", "newer job", "task");
      } else if (i.agent.name === "fe-member") prompts.push(i.userPrompt);
      return OK;
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("subject: older job");
    expect(prompts[0]).toContain("body of older job");
    expect(prompts[0]).not.toContain("body of newer job");
    const queued = /Queued messages[\s\S]*"newer job" -> (\S+)/.exec(prompts[0]);
    expect(queued).not.toBeNull();
    expect(prompts[1]).toContain("subject: newer job");
    expect(prompts[1]).toContain("body of newer job");
  });

  it("stops at max_rounds", async () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("max_rounds: 30", "max_rounds: 4"));
    const s = await run(async (i) => {
      mail(i, i.agent.name === "lead" ? "fe-member" : "lead", "ping");
      return OK;
    });
    expect(s.endReason).toBe("max_rounds");
    expect(s.rounds).toBe(4);
  });

  it("retries once, then tells the lead when a teammate keeps failing", async () => {
    env = makeEnv();
    let feCalls = 0;
    let leadPrompt = "";
    let leadCalls = 0;
    const s = await run(async (i) => {
      if (i.agent.name === "lead") {
        leadCalls++;
        if (leadCalls === 1) mail(i, "fe-member", "work", "task");
        else {
          leadPrompt = i.userPrompt;
          mail(i, "lead", "giving up", "done");
        }
        return OK;
      }
      feCalls++;
      return { ...OK, ok: false, exitCode: 1, error: "exploded" };
    });
    expect(feCalls).toBe(2); // 1 try + 1 retry
    expect(leadPrompt).toContain("fe-member failed");
    expect(leadPrompt).toContain("exploded");
    expect(s.endReason).toBe("done");
    expect(s.rounds).toBe(4);
  });

  it("aborts when the lead itself fails", async () => {
    env = makeEnv();
    const s = await run(async () => ({ ...OK, ok: false, exitCode: 1, error: "no auth" }));
    expect(s.endReason).toBe("lead_failed");
    expect(s.rounds).toBe(2); // try + retry
  });

  it("ends as idle when nobody has mail left and no done was sent", async () => {
    env = makeEnv();
    const s = await run(async () => OK);
    expect(s.endReason).toBe("idle");
    expect(s.rounds).toBe(2); // first wake + one reminder wake
  });

  it("gives every run its own task memory dir per agent", async () => {
    env = makeEnv();
    const dirs: string[] = [];
    const s = await run(async (i) => {
      dirs.push(i.agent.memory.task ?? "");
      if (i.agent.name === "lead") mail(i, "lead", "bye", "done");
      return OK;
    });
    const p = env.project();
    expect(dirs[0]).toBe(path.join(p.paths.taskMemory, s.runId, "lead"));
    expect(fs.existsSync(dirs[0])).toBe(true);
    const other = path.join(p.paths.taskMemory, "other-run", "lead");
    expect(dirs[0]).not.toBe(other);
  });

  it("reminds the lead once when it ends a run without done, and accepts done then", async () => {
    env = makeEnv();
    const prompts: string[] = [];
    const s = await run(async (i) => {
      prompts.push(i.userPrompt);
      if (prompts.length === 2) mail(i, "lead", "finished", "done");
      return OK;
    });
    expect(prompts[1]).toContain("No done message sent");
    expect(s.endReason).toBe("done");
    expect(s.rounds).toBe(2);
  });

  it("reverts unauthorized edits to protected files and warns the lead", async () => {
    env = makeEnv();
    fs.writeFileSync(path.join(env.repo, "CLAUDE.md"), "repo rules\n");
    const feMd = env.project().agents["fe-member"].agentMd;
    const original = fs.readFileSync(feMd, "utf8");
    let leadPrompt = "";
    let step = 0;
    const s = await run(async (i) => {
      step++;
      if (i.agent.name === "lead" && step === 1) mail(i, "fe-member", "go", "task");
      else if (i.agent.name === "fe-member") {
        fs.writeFileSync(feMd, "I rewrote my own persona");
        fs.writeFileSync(path.join(env.repo, "CLAUDE.md"), "hacked\n");
        fs.writeFileSync(path.join(env.repo, "src.txt"), "legit work\n");
      } else if (i.agent.name === "lead") {
        leadPrompt = i.userPrompt;
        mail(i, "lead", "bye", "done");
      }
      return OK;
    });
    expect(fs.readFileSync(feMd, "utf8")).toBe(original);
    expect(fs.readFileSync(path.join(env.repo, "CLAUDE.md"), "utf8")).toBe("repo rules\n");
    expect(fs.existsSync(path.join(env.repo, "src.txt"))).toBe(true);
    expect(leadPrompt).toContain("Protected file restored");
    expect(events(s.runDir).filter((e) => e.event === "violation")).toHaveLength(2);
  });

  it("allows the lead to edit COMMON.md and AGENT.md, and accepts that as the new baseline", async () => {
    env = makeEnv();
    const p = env.project();
    const common = path.join(p.paths.shared, "common", "COMMON.md");
    const s = await run(async (i) => {
      if (i.agent.name === "lead") {
        fs.writeFileSync(common, "# updated by lead\n");
        fs.appendFileSync(p.agents["qa-member"].agentMd, "\nnew rule\n");
        mail(i, "lead", "ok", "done");
      }
      return OK;
    });
    expect(fs.readFileSync(common, "utf8")).toBe("# updated by lead\n");
    expect(fs.readFileSync(p.agents["qa-member"].agentMd, "utf8")).toContain("new rule");
    expect(events(s.runDir).some((e) => e.event === "violation")).toBe(false);
  });

  it("resumes only agents with resume: true and remembers their session", async () => {
    env = makeEnv();
    const sessions: (string | undefined)[] = [];
    let n = 0;
    await run(async (i) => {
      if (i.agent.name === "lead") {
        sessions.push(i.sessionId);
        n++;
        if (n === 1) mail(i, "fe-member", "x", "task");
        else mail(i, "lead", "bye", "done");
        return { ...OK, sessionId: `lead-sess-${n}` };
      }
      expect(i.sessionId).toBeUndefined();
      mail(i, "lead", "back");
      return { ...OK, sessionId: "fe-sess" };
    });
    expect(sessions).toEqual([undefined, "lead-sess-1"]);
  });

  it("runs disjoint-owns agents in parallel but never alongside the lead", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    env.editProjectYaml((t) =>
      t
        .replace("max_parallel: 1", "max_parallel: 2")
        .replace('    # owns: ["src/web/**"]', '    owns: ["src/web/**"]')
        .replace('    # owns: ["tests/**"]', '    owns: ["tests/**"]'),
    );
    let active = 0;
    let maxActive = 0;
    let leadCalls = 0;
    const s = await run(async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      if (i.agent.name === "lead") {
        leadCalls++;
        if (leadCalls === 1) {
          mail(i, "fe-member", "a", "task");
          mail(i, "qa-member", "b", "task");
        } else mail(i, "lead", "bye", "done");
      } else mail(i, "lead", "reply");
      active--;
      return OK;
    });
    expect(s.endReason).toBe("done");
    expect(maxActive).toBe(2);
  });

  it("hands the lead all waiting replies in one wake-up, but workers get one message at a time", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    env.editProjectYaml((t) =>
      t
        .replace("max_parallel: 1", "max_parallel: 2")
        .replace('    # owns: ["src/web/**"]', '    owns: ["src/web/**"]')
        .replace('    # owns: ["tests/**"]', '    owns: ["tests/**"]'),
    );
    const leadPrompts: string[] = [];
    const s = await run(async (i) => {
      if (i.agent.name === "lead") {
        leadPrompts.push(i.userPrompt);
        if (leadPrompts.length === 1) {
          mail(i, "fe-member", "a", "task");
          mail(i, "qa-member", "b", "task");
        } else mail(i, "lead", "bye", "done");
      } else mail(i, "lead", `reply from ${i.agent.name}`);
      return OK;
    });
    expect(s.endReason).toBe("done");
    expect(s.rounds).toBe(4);
    expect(leadPrompts).toHaveLength(2);
    expect(leadPrompts[1]).toContain("Messages to handle now (2");
    expect(leadPrompts[1]).toContain("body of reply from fe-member");
    expect(leadPrompts[1]).toContain("body of reply from qa-member");
    expect(leadPrompts[1]).not.toContain("Queued messages");
    const state = JSON.parse(fs.readFileSync(path.join(s.runDir, "state.json"), "utf8"));
    expect(state.wakes.find((w: { round: number }) => w.round === 4).handling).toHaveLength(2);
  });
});

describe("task input", () => {
  it("copies a task file read-only, inlines small ones and references large ones", async () => {
    env = makeEnv();
    const small = path.join(env.root, "small.md");
    fs.writeFileSync(small, "# Add search\n\ndetails");
    const runDir = path.join(env.root, "r1");
    const t = prepareTask({ file: small, cwd: env.root, runDir });
    expect(t).toMatchObject({ source: "file", sourcePath: small, inline: true });
    expect(fs.readFileSync(path.join(runDir, "task.md"), "utf8")).toContain("Add search");
    expect(fs.statSync(path.join(runDir, "task.md")).mode & 0o222).toBe(0);

    const big = path.join(env.root, "big.md");
    fs.writeFileSync(big, "# Big spec\n" + "x".repeat(TASK_INLINE_MAX + 10));
    const tb = prepareTask({ file: "big.md", cwd: env.root, runDir: path.join(env.root, "r2") });
    expect(tb.inline).toBe(false);
  });

  it("rejects missing, empty, oversized, and ambiguous input without touching the source", () => {
    env = makeEnv();
    const empty = path.join(env.root, "empty.md");
    fs.writeFileSync(empty, "  \n");
    const huge = path.join(env.root, "huge.md");
    fs.writeFileSync(huge, "x".repeat(TASK_FILE_MAX + 1));
    expect(() => readTaskFile(path.join(env.root, "nope.md"))).toThrow(/not found/);
    expect(() => readTaskFile(empty)).toThrow(/empty/);
    expect(() => readTaskFile(huge)).toThrow(/limit/);
    const base = { cwd: env.root, runDir: path.join(env.root, "r") };
    expect(() => prepareTask({ ...base, text: "a", file: empty })).toThrow(/not both/);
    expect(() => prepareTask({ ...base })).toThrow(/No task/);
    expect(fs.readFileSync(huge, "utf8")).toHaveLength(TASK_FILE_MAX + 1);
  });
});

describe("resume", () => {
  const stateOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));

  it("continues an interrupted run: keeps the run dir and sessions, redoes the unread mail, does not resend the task", async () => {
    env = makeEnv();
    const s1 = await run(async () => {
      throw new Error("killed");
    });
    expect(s1.endReason).toBe("lead_failed");
    const runDir = s1.runDir;
    // Make it look like a killed process: no end reason, a wake still active, a session recorded.
    const st = stateOf(runDir);
    delete st.end_reason;
    delete st.ended_at;
    st.sessions = { lead: "sess-1" };
    st.active = { lead: { round: st.rounds, since: new Date().toISOString(), handling: [] } };
    fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(st));
    // A killed wake never consumed its mail: undo the failed wake's commit (mail back in the inbox, no claim record).
    fs.rmSync(path.join(runDir, "mail", "claims"), { recursive: true, force: true });
    const leadInbox = inboxDir(bindRunProject(env.project(), runDir, "run"), "lead");
    for (const f of fs.readdirSync(path.join(leadInbox, "read"))) fs.renameSync(path.join(leadInbox, "read", f), path.join(leadInbox, f));

    const seenSessions: (string | undefined)[] = [];
    const s2 = await runTeam({
      project: env.project(),
      resume: stateOf(runDir),
      runDir,
      log: () => {},
      invoker: async (i) => {
        seenSessions.push(i.sessionId);
        mail(i, "lead", "finished", "done");
        return OK;
      },
    });
    expect(s2.runDir).toBe(runDir);
    expect(s2.endReason).toBe("done");
    expect(seenSessions).toEqual(["sess-1"]);
    const after = stateOf(runDir);
    expect(after.rounds).toBe(s1.rounds + 1);
    expect(after.wakes.some((w: { error?: string }) => w.error === "interrupted")).toBe(true);
    expect(events(runDir).filter((e) => e.event === "start")).toHaveLength(1);
    expect(events(runDir).some((e) => e.event === "resume")).toBe(true);
    expect(fs.readdirSync(leadInbox).filter((f) => f.includes("-user-"))).toHaveLength(0);
  });
});

describe("guard", () => {
  it("removes a protected file that an unauthorized agent created", () => {
    env = makeEnv();
    const p = env.project();
    const g = new ProtectedGuard(p);
    const f = path.join(env.repo, "AGENTS.md");
    fs.writeFileSync(f, "new");
    const v = g.check([p.agents["fe-member"]]);
    expect(v).toEqual([{ file: f, action: "removed", suspects: ["fe-member"] }]);
    expect(fs.existsSync(f)).toBe(false);
  });
});

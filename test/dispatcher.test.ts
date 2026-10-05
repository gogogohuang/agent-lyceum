import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import { runTeam, type RunSummary } from "../src/dispatcher.js";
import { ProtectedGuard } from "../src/guard.js";
import { outboxDir } from "../src/policy.js";
import { prepareTask, readTaskFile, TASK_FILE_MAX, TASK_INLINE_MAX } from "../src/task.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const mail = (i: WakeInput, to: string, subject: string, type = "reply") =>
  write(path.join(outboxDir(i.project, i.agent.name), `${Date.now()}-${Math.random()}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n---\n\nbody of ${subject}\n`);

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
    const state = JSON.parse(fs.readFileSync(path.join(s.runDir, "state.json"), "utf8"));
    expect(state.end_reason).toBe("done");
    expect(state.task_source).toBe("text");
    expect(fs.readFileSync(path.join(s.runDir, "task.md"), "utf8")).toContain("build the thing");
    expect(events(s.runDir).filter((e) => e.event === "wake")).toHaveLength(3);
  });

  it("passes only the latest message in full and lists older ones", async () => {
    env = makeEnv();
    let prompt = "";
    let first = true;
    await run(async (i) => {
      if (i.agent.name === "lead" && first) {
        first = false;
        mail(i, "fe-member", "older job", "task");
        mail(i, "fe-member", "newer job", "task");
      } else if (i.agent.name === "fe-member") prompt = i.userPrompt;
      return OK;
    });
    expect(prompt).toContain("# Message to handle now");
    expect(prompt).toContain("subject: newer job");
    expect(prompt).toContain("body of newer job");
    expect(prompt).not.toContain("body of older job");
    expect(prompt).toMatch(/Other unread messages[\s\S]*"older job"/);
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
    expect(s.rounds).toBe(1);
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

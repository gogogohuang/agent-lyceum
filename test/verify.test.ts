import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { rejectDone } from "../src/mailbox.js";
import { setFaultHook } from "../src/message-store.js";
import type { CommandRunner } from "../src/open-pr.js";
import { outboxDir, sharedContextFiles } from "../src/policy.js";
import { repeatStopNote } from "../src/repeat-detect.js";
import { bindRunProject, loadRunState, saveRunState } from "../src/run-store.js";
import { ProjectConfig } from "../src/schema.js";
import { prepareTask } from "../src/task.js";
import { logBody, nextLogNumber, runCommand, tailText, VERIFY_LOG_BYTES } from "../src/verify.js";
import { workingTreeHash } from "../src/worktree.js";
import { buildRunReport, formatStatusReport } from "../src/status.js";
import { FULL_DONE, git, initGitRepo, makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => {
  setFaultHook(undefined);
  env?.cleanup();
});

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const verifyYaml = (cmds: { name: string; run: string; timeout_sec?: number }[], max?: number) =>
  `\nverify:\n${max === undefined ? "" : `  max_rejections: ${max}\n`}  commands:\n${cmds.map((c) => `    - { name: ${c.name}, run: ${JSON.stringify(c.run)}${c.timeout_sec ? `, timeout_sec: ${c.timeout_sec}` : ""} }`).join("\n")}\n`;
const withVerify = (cmds: { name: string; run: string; timeout_sec?: number }[], max?: number) => env.editProjectYaml((t) => t + verifyYaml(cmds, max));
let n = 0;
const sendDone = (i: WakeInput, outcome = "completed", body = FULL_DONE, extra = "") =>
  write(path.join(outboxDir(i.project, i.agent.name), `done-${++n}.md`), `---\ntype: done\nsubject: finished ${n}\noutcome: ${outcome}\n${extra}---\n\n${body}\n`);
const PARTIAL = "## Result\nHalf.\n\n## Not done\nThe rest\n";
const start = (project = env.project()) => {
  const runDir = path.join(project.paths.runs, "run-1");
  return { project, runDir, task: prepareTask({ text: "go", cwd: env.root, runDir }) };
};
const events = (runDir: string): { event: string; [k: string]: unknown }[] =>
  fs.readFileSync(path.join(runDir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
/** Resolves when the command has printed `word` (explicit readiness from the child, no polling). */
const readyOn = (word: string) => {
  let seen = "";
  let ok!: () => void;
  const ready = new Promise<void>((r) => (ok = r));
  return {
    ready,
    onOutput: (c: Buffer) => {
      seen += c.toString();
      if (seen.includes(word)) ok();
    },
  };
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** The process is gone; a SIGKILLed process may take a few milliseconds to disappear, so this waits (at most 1 s) for that and nothing else. */
const gone = async (pid: number) => {
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
  return !alive(pid);
};
const FAST = { killGraceMs: 100, settleWaitMs: 100 };
/** Every message file in the run's mail whose text contains `needle`. */
const mailWith = (runDir: string, needle: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md") && fs.readFileSync(p, "utf8").includes(needle)) out.push(p);
    }
  };
  walk(path.join(runDir, "mail"));
  return out;
};

describe("verify schema and config", () => {
  const base = { dir: "/x", team: { lead: "l" } };
  const parse = (verify: unknown) => ProjectConfig.safeParse({ ...base, verify });
  it("accepts a valid block and fills the defaults when resolved", () => {
    env = makeEnv();
    withVerify([{ name: "t-1", run: "true" }]);
    expect(env.project().verify).toEqual({ max_rejections: 2, commands: [{ name: "t-1", run: "true", timeout_sec: 600 }] });
  });
  it("no verify, or an empty commands list, means off", () => {
    env = makeEnv();
    expect(env.project().verify).toBeUndefined();
    env.editProjectYaml((t) => `${t}\nverify:\n  commands: []\n`);
    expect(env.project().verify).toBeUndefined();
  });
  it.each([
    ["unknown key", { commands: [{ name: "a", run: "x" }], fail_fast: true }],
    ["unknown command key", { commands: [{ name: "a", run: "x", cwd: "/" }] }],
    ["duplicate name", { commands: [{ name: "a", run: "x" }, { name: "a", run: "y" }] }],
    ["bad name", { commands: [{ name: "A_b", run: "x" }] }],
    ["missing run", { commands: [{ name: "a" }] }],
    ["timeout 0", { commands: [{ name: "a", run: "x", timeout_sec: 0 }] }],
    ["timeout 7201", { commands: [{ name: "a", run: "x", timeout_sec: 7201 }] }],
    ["max_rejections 6", { max_rejections: 6, commands: [] }],
    ["max_rejections -1", { max_rejections: -1, commands: [] }],
  ])("rejects %s", (_n, v) => {
    expect(parse(v).success).toBe(false);
  });
  it("names the unknown key in the load error", () => {
    env = makeEnv();
    env.editProjectYaml((t) => `${t}\nverify:\n  fail_fast: true\n  commands: []\n`);
    expect(() => env.project()).toThrow(/fail_fast/);
  });
});

describe("runCommand", () => {
  const tmp = () => {
    env = makeEnv();
    return env.root;
  };
  it("keeps CRLF output as written in the log body and reports the exit code", async () => {
    const r = await runCommand("printf 'a\\r\\nb\\r\\n'; exit 3", { cwd: tmp(), timeoutSec: 10, ...FAST });
    expect(r).toMatchObject({ cancelled: false, exit: 3, timedOut: false });
    if (r.cancelled) throw new Error("unreachable");
    expect(r.output.toString()).toBe("a\r\nb\r\n");
  });
  it("cuts the tail on a character boundary", () => {
    const s = Buffer.from("é".repeat(10)); // 2 bytes each
    expect(tailText(s, 5)).toBe("éé"); // 5 would start inside a character
    expect(tailText(s, 4)).toBe("éé");
  });
  it("truncates output above 1 MiB and says so at the top", async () => {
    const r = await runCommand(`head -c ${VERIFY_LOG_BYTES * 3} /dev/zero | tr '\\0' 'x'`, { cwd: tmp(), timeoutSec: 30, ...FAST });
    if (r.cancelled) throw new Error("unreachable");
    const body = logBody(r.output);
    const head = body.subarray(0, 200).toString().split("\n")[0]!;
    expect(head).toMatch(/^\[agent-lyceum: output truncated; the first \d+ byte\(s\) are not kept, the last \d+ follow\]$/);
    expect(body.length).toBeLessThanOrEqual(VERIFY_LOG_BYTES + head.length + 1);
    expect(body.length).toBeGreaterThan(VERIFY_LOG_BYTES);
  });
  it("a missing executable fails with sh's own message", async () => {
    const r = await runCommand("definitely-not-a-command-xyz", { cwd: tmp(), timeoutSec: 10, ...FAST });
    if (r.cancelled) throw new Error("unreachable");
    expect(r.exit).toBe(127);
    expect(r.output.toString()).toMatch(/not found/);
  });
  it("a missing working directory is a failure with a readable error", async () => {
    const r = await runCommand("true", { cwd: path.join(tmp(), "nope"), timeoutSec: 10, ...FAST });
    if (r.cancelled) throw new Error("unreachable");
    expect(r.error).toMatch(/not found/);
  });
  it("timeout kills the whole group, also a background child that holds the pipes", async () => {
    const dir = tmp();
    const pidFile = path.join(dir, "bg.pid");
    const r = await runCommand(`sleep 60 & echo $! > ${pidFile}; wait`, { cwd: dir, timeoutSec: 1, ...FAST });
    if (r.cancelled) throw new Error("unreachable");
    expect(r.timedOut).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(await gone(pid)).toBe(true);
  });
  it("cancel gives no result and leaves no process", async () => {
    const dir = tmp();
    const ac = new AbortController();
    const rd = readyOn("ready");
    const p = runCommand(`sleep 60 & echo $! > ${dir}/bg.pid; echo ready; wait`, { cwd: dir, timeoutSec: 60, signal: ac.signal, onOutput: rd.onOutput, ...FAST });
    await rd.ready;
    ac.abort();
    expect(await p).toEqual({ cancelled: true });
    expect(await gone(Number(fs.readFileSync(path.join(dir, "bg.pid"), "utf8")))).toBe(true);
  });
  it("an already aborted signal starts nothing", async () => {
    const dir = tmp();
    const ac = new AbortController();
    ac.abort();
    expect(await runCommand(`touch ${dir}/x`, { cwd: dir, timeoutSec: 5, signal: ac.signal })).toEqual({ cancelled: true });
    expect(fs.existsSync(path.join(dir, "x"))).toBe(false);
  });
  it("cancel during a timeout's cleanup wins: no verdict", async () => {
    const dir = tmp();
    const ac = new AbortController();
    const rd = readyOn("ready");
    const p = runCommand("trap '' TERM; echo ready; sleep 60 & wait", { cwd: dir, timeoutSec: 1, signal: ac.signal, onOutput: rd.onOutput, killGraceMs: 1000, settleWaitMs: 100 });
    await rd.ready;
    setTimeout(() => ac.abort(), 1200); // the timeout fired at 1000 ms and the TERM-proof shell is still in its grace period
    expect(await p).toEqual({ cancelled: true });
  });
  it("an abort after the process exited but before the result is judged also withholds the verdict", async () => {
    const dir = tmp();
    const ac = new AbortController();
    const rd = readyOn("ready");
    // the shell exits at once, a background child keeps the pipes, so the result waits settleWaitMs
    const p = runCommand("sleep 60 & echo ready; exit 0", { cwd: dir, timeoutSec: 30, signal: ac.signal, onOutput: rd.onOutput, killGraceMs: 100, settleWaitMs: 600 });
    await rd.ready;
    setTimeout(() => ac.abort(), 200);
    expect(await p).toEqual({ cancelled: true });
  });
  it("numbers logs above every record and every file already there", () => {
    const dir = tmp();
    expect(nextLogNumber(dir, undefined)).toBe(1);
    write(path.join(dir, "verify", "4-test.log"), "x");
    expect(nextLogNumber(dir, undefined)).toBe(5);
    const rec = { at: "", passed: false, source: "s", commands: [{ name: "a", exit: 1, ms: 1, timed_out: false, log: "verify/9-a.log" }] };
    expect(nextLogNumber(dir, [rec])).toBe(10);
  });
});

describe("a completed done is verified by the dispatcher", () => {
  /** The lead sends a completed done on each wake; `after` lets a test script what it does next. */
  const leadDones = (calls: { n: number }, extra?: (i: WakeInput, k: number) => void): Invoker => async (i) => {
    calls.n++;
    extra?.(i, calls.n);
    sendDone(i);
    return OK;
  };

  it("no verify: nothing is run and result.md has no verification section", async () => {
    env = makeEnv();
    const { project, runDir, task } = start();
    const s = await runTeam({ project, task, runDir, log: () => {}, invoker: leadDones({ n: 0 }) });
    expect(s.outcome).toBe("completed");
    expect(fs.readFileSync(path.join(runDir, "result.md"), "utf8")).not.toContain("Dispatcher verification");
    expect(loadRunState(runDir).verify).toBeUndefined();
    expect(fs.existsSync(path.join(runDir, "verify"))).toBe(false);
    expect(events(runDir).some((e) => e.event === "verify-repeat")).toBe(false);
  });

  it("all pass: accepted, section in result.md and done-1.md, record in state, events logged", async () => {
    env = makeEnv();
    withVerify([{ name: "one", run: "echo hello" }, { name: "two", run: "true" }]);
    const { project, runDir, task } = start();
    const s = await runTeam({ project, task, runDir, log: () => {}, invoker: leadDones({ n: 0 }) });
    expect(s.outcome).toBe("completed");
    for (const f of ["result.md", "done-1.md"]) {
      const t = fs.readFileSync(path.join(runDir, f), "utf8");
      expect(t).toContain("## Dispatcher verification");
      expect(t).toContain("all commands passed");
      expect(t.indexOf("## Dispatcher verification")).toBeGreaterThan(t.indexOf("## Not done"));
    }
    const st = loadRunState(runDir);
    expect(st.verify).toHaveLength(1);
    expect(st.verify![0]).toMatchObject({ passed: true, commands: [{ name: "one", exit: 0, log: "verify/1-one.log" }, { name: "two", exit: 0, log: "verify/2-two.log" }] });
    expect(st.verify![0]!.diff_hash).toBeUndefined(); // not a git repo
    expect(fs.readFileSync(path.join(runDir, "verify", "1-one.log"), "utf8")).toBe("hello\n");
    const ev = events(runDir).map((e) => e.event);
    expect(ev.filter((e) => e === "verify-start")).toHaveLength(2);
    expect(ev.filter((e) => e === "verify-end")).toHaveLength(2);
    expect(ev).not.toContain("verify-repeat");
    expect(JSON.stringify(st.verify)).not.toMatch(/fingerprint|repeat_stop_segment/);
  });

  it("the doneMessage keeps the lead's body only", async () => {
    env = makeEnv();
    withVerify([{ name: "one", run: "true" }]);
    const { project, runDir, task } = start();
    const s = await runTeam({ project, task, runDir, log: () => {}, invoker: leadDones({ n: 0 }) });
    expect(s.doneMessage?.body).not.toContain("Dispatcher verification");
  });

  it("non-worktree mode runs in project.dir", async () => {
    env = makeEnv();
    withVerify([{ name: "where", run: `pwd > ${path.join(env.root, "cwd.txt")}` }]);
    const { project, runDir, task } = start();
    await runTeam({ project, task, runDir, log: () => {}, invoker: leadDones({ n: 0 }) });
    expect(fs.realpathSync(fs.readFileSync(path.join(env.root, "cwd.txt"), "utf8").trim())).toBe(fs.realpathSync(project.dir));
  });

  it("worktree mode runs in the lead's worktree and records the tree hash from before the commands ran", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    withVerify([{ name: "where", run: `pwd > ${path.join(env.root, "cwd.txt")}; touch made-by-verify.txt` }]);
    const { project, runDir, task } = start();
    const s = await runTeam({ project, task, runDir, log: () => {}, invoker: leadDones({ n: 0 }, (i) => write(path.join(i.project.workspaces?.lead?.dir ?? "", "lead-edit.txt"), "x\n")) });
    expect(s.endReason).toBe("done");
    const cwd = fs.realpathSync(fs.readFileSync(path.join(env.root, "cwd.txt"), "utf8").trim());
    expect(cwd).not.toBe(fs.realpathSync(env.repo));
    expect(cwd).toContain(`${path.sep}worktrees${path.sep}`);
    const rec = loadRunState(runDir).verify![0]!;
    expect(rec.diff_hash).toMatch(/^[0-9a-f]{40}$/);
    // the file the command made was not in the hash taken before it ran: hashing the tree now gives another value
    const after = await workingTreeHash(project, { agent: "lead", root: cwd, dir: cwd, gitDir: "", commonDir: "", branch: "", base: "" });
    expect(after === undefined || after !== rec.diff_hash).toBe(true);
  });

  it("first command fails: rejected with exit code and output, the second is not run, the lead can try again", async () => {
    env = makeEnv();
    const marker = path.join(env.root, "second-ran");
    const flag = path.join(env.root, "fixed");
    withVerify([{ name: "first", run: `if [ -f ${flag} ]; then exit 0; fi; echo "boom: line 7"; exit 3` }, { name: "second", run: `touch ${marker}` }]);
    const { project, runDir, task } = start();
    let seen = "";
    const calls = { n: 0 };
    const s = await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      invoker: leadDones(calls, (i, k) => {
        if (k === 2) {
          seen = i.userPrompt;
          fs.writeFileSync(flag, "1");
          expect(fs.existsSync(marker)).toBe(false);
        }
      }),
    });
    expect(calls.n).toBe(2);
    expect(seen).toContain("failed verification");
    expect(seen).toContain("exited with code 3");
    expect(seen).toContain("boom: line 7");
    expect(seen).toContain("Verification rejection 1 of 2");
    expect(s.outcome).toBe("completed");
    const st = loadRunState(runDir);
    expect(st.verify).toHaveLength(2);
    expect(st.verify![0]).toMatchObject({ passed: false });
    expect(st.verify![0]!.commands).toHaveLength(1);
    expect(st.verify_rejections).toBe(1);
    expect(fs.existsSync(marker)).toBe(true); // the second command ran once the first passed
    expect(fs.existsSync(path.join(runDir, "verify", "1-first.log"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "verify", "2-first.log"))).toBe(true); // the retry did not overwrite attempt one
  });

  it("rejections used up: accepted as partial with a note naming the command; no pull request", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    withVerify([{ name: "test", run: "echo nope; exit 1" }], 1);
    const { project, runDir, task } = start();
    const prCalls: string[][] = [];
    const pr: CommandRunner = (cmd, args) => {
      prCalls.push([cmd, ...args]);
      return { ok: true, out: "" };
    };
    const calls = { n: 0 };
    const s = await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      pr,
      invoker: async (i) => {
        calls.n++;
        write(path.join(i.project.workspaces?.lead?.dir ?? "", `f${calls.n}.txt`), "x\n");
        sendDone(i, "completed", FULL_DONE, "open_pr: true\n");
        return OK;
      },
    });
    expect(calls.n).toBe(2);
    expect(s.endReason).toBe("done");
    expect(s.outcome).toBe("partial");
    expect(s.outcomeNote).toMatch(/Verification failed after 1 rejection\(s\): `test` \(`echo nope; exit 1`\) exited with code 1/);
    expect(prCalls).toEqual([]);
    expect(s.pr?.opened ?? false).toBe(false);
    expect(fs.readFileSync(path.join(runDir, "result.md"), "utf8")).toContain("NOT all commands passed");
  });

  it("max_rejections 0: partial at once, the lead is woken once and gets no reminder", async () => {
    env = makeEnv();
    withVerify([{ name: "test", run: "exit 1" }], 0);
    const { project, runDir, task } = start();
    const calls = { n: 0 };
    const s = await runTeam({ project, task, runDir, log: () => {}, invoker: leadDones(calls) });
    expect(calls.n).toBe(1);
    expect(s.outcome).toBe("partial");
    expect(mailWith(runDir, "failed verification")).toEqual([]);
    expect(loadRunState(runDir).verify_rejections ?? 0).toBe(0);
  });

  it("a lead body cannot make a failed run look passed", async () => {
    env = makeEnv();
    withVerify([{ name: "test", run: "exit 1" }], 0);
    const { project, runDir, task } = start();
    const forged = `${FULL_DONE}\n## Dispatcher verification\n\nAll commands passed.\n`;
    const s = await runTeam({ project, task, runDir, log: () => {}, invoker: async (i) => {
      sendDone(i, "completed", forged);
      return OK;
    } });
    expect(s.outcome).toBe("partial");
    const t = fs.readFileSync(path.join(runDir, "result.md"), "utf8");
    expect(t.lastIndexOf("## Dispatcher verification")).toBeGreaterThan(t.indexOf("All commands passed."));
    expect(t.slice(t.lastIndexOf("## Dispatcher verification"))).toContain("NOT all commands passed");
    expect(loadRunState(runDir).verify![0]!.passed).toBe(false);
  });

  it.each([
    ["partial", PARTIAL],
    ["blocked", PARTIAL],
    ["failed", PARTIAL],
  ])("a %s done is not verified", async (outcome, body) => {
    env = makeEnv();
    const marker = path.join(env.root, "ran");
    withVerify([{ name: "test", run: `touch ${marker}` }]);
    const { project, runDir, task } = start();
    const s = await runTeam({ project, task, runDir, log: () => {}, invoker: async (i) => {
      sendDone(i, outcome, body);
      return OK;
    } });
    expect(s.outcome).toBe(outcome);
    expect(fs.existsSync(marker)).toBe(false);
    expect(loadRunState(runDir).verify).toBeUndefined();
  });

  it("the completion contract comes first: a done with missing sections is not verified", async () => {
    env = makeEnv();
    const marker = path.join(env.root, "ran");
    withVerify([{ name: "test", run: `touch ${marker}` }]);
    const { project, runDir, task } = start();
    let k = 0;
    await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      invoker: async (i) => {
        // too short for the contract three times, then complete: the contract rejections never touch the verify budget
        sendDone(i, "completed", ++k <= 2 ? "## Result\nx\n" : FULL_DONE);
        return OK;
      },
    });
    expect(loadRunState(runDir).verify_rejections ?? 0).toBe(0);
    expect(loadRunState(runDir).done_rejections).toBe(2);
    expect(loadRunState(runDir).verify).toHaveLength(1);
  });

  it("a done kept as partial after the contract reminders ran out is not verified", async () => {
    env = makeEnv();
    const marker = path.join(env.root, "ran");
    withVerify([{ name: "test", run: `touch ${marker}` }]);
    const { project, runDir, task } = start();
    const s = await runTeam({ project, task, runDir, log: () => {}, invoker: async (i) => {
      sendDone(i, "completed", "## Result\nx\n");
      return OK;
    } });
    expect(s.outcome).toBe("partial");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("a timeout is a failure the lead is told about", async () => {
    env = makeEnv();
    withVerify([{ name: "slow", run: "sleep 60", timeout_sec: 1 }], 0);
    const { project, runDir, task } = start();
    const s = await runTeam({ project, task, runDir, log: () => {}, invoker: leadDones({ n: 0 }), verifyTiming: FAST });
    expect(s.outcome).toBe("partial");
    expect(s.outcomeNote).toContain("timed out after 1s");
    expect(loadRunState(runDir).verify![0]!.commands[0]).toMatchObject({ name: "slow", timed_out: true });
  });

  it("an unknown command is a readable failure", async () => {
    env = makeEnv();
    withVerify([{ name: "bad", run: "definitely-not-a-command-xyz" }], 0);
    const { project, runDir, task } = start();
    const s = await runTeam({ project, task, runDir, log: () => {}, invoker: leadDones({ n: 0 }) });
    expect(s.outcome).toBe("partial");
    expect(fs.readFileSync(path.join(runDir, "verify", "1-bad.log"), "utf8")).toMatch(/not found/);
  });

  it("both downgrades: unintegrated member work (blocked) and a failed verification name each other in the note", async () => {
    const { resolveDoneOutcome } = await import("../src/run-outcome.js");
    const contract = { missing: [], outcome: "completed" as const };
    const r = resolveDoneOutcome(contract as never, 0, [{ agent: "fe", branch: "b", report: "r.md" }], { note: "Verification failed." });
    expect(r.outcome).toBe("blocked");
    expect(r.note).toContain("never brought into the repo");
    expect(r.note).toContain("Verification failed.");
    expect(resolveDoneOutcome(contract as never, 0, [], { note: "V" })).toMatchObject({ outcome: "partial", note: "V" });
  });

  it("the verify command may change a protected file: the guard neither detects nor restores it", async () => {
    env = makeEnv();
    const common = sharedContextFiles(env.project()).find((f) => f.endsWith("COMMON.md")) ?? sharedContextFiles(env.project())[0]!;
    write(common, "original\n");
    const flag = path.join(env.root, "fixed");
    withVerify([{ name: "touch", run: `echo "changed by verify" >> ${JSON.stringify(common)}; if [ -f ${flag} ]; then exit 0; fi; exit 1` }]);
    const { project, runDir, task } = start();
    const calls = { n: 0 };
    await runTeam({ project, task, runDir, log: () => {}, invoker: leadDones(calls, (_i, k) => k === 2 && fs.writeFileSync(flag, "1")) });
    expect(calls.n).toBe(2);
    expect(fs.readFileSync(common, "utf8")).toContain("changed by verify");
    expect(events(runDir).some((e) => e.event === "violation")).toBe(false);
  });

  it("run --agent: the solo lead's done is verified too", async () => {
    env = makeEnv();
    const { soloProject } = await import("../src/solo.js");
    withVerify([{ name: "test", run: "exit 1" }], 0);
    const base = env.project();
    const project = soloProject(base, base.lead);
    const { runDir, task } = start(project);
    const s = await runTeam({ project, task, runDir, log: () => {}, invoker: leadDones({ n: 0 }) });
    expect(s.outcome).toBe("partial");
  });
});

describe("cancel and crash replay", () => {
  it("cancel in mid-verify: no verdict, the done stays in the outbox, run ends cancelled, resume verifies again", async () => {
    env = makeEnv();
    withVerify([{ name: "hang", run: "sleep 60" }]);
    const { project, runDir, task } = start();
    const ac = new AbortController();
    const calls = { n: 0 };
    // the dispatcher announces "verifying" right before it starts the first command; the abort lands after the spawn
    const log = (t: string) => {
      if (t.includes("verifying ")) setTimeout(() => ac.abort(), 0);
    };
    const p = runTeam({ project, task, runDir, log, signal: ac.signal, verifyTiming: FAST, invoker: async (i) => {
      calls.n++;
      sendDone(i);
      return OK;
    } });
    const s = await p;
    expect(s.endReason).toBe("cancelled");
    expect(s.outcome).toBe("cancelled");
    const outbox = outboxDir(bindRunProject(project, runDir, "run"), project.lead);
    expect(fs.readdirSync(outbox).filter((f) => f.endsWith(".md"))).toHaveLength(1); // unjudged
    expect(fs.existsSync(path.join(outbox, "rejected")) ? fs.readdirSync(path.join(outbox, "rejected")) : []).toEqual([]);
    expect(fs.existsSync(path.join(outbox, "read")) ? fs.readdirSync(path.join(outbox, "read")) : []).toEqual([]);
    expect(fs.existsSync(path.join(runDir, "result.md"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "done-1.md"))).toBe(false);
    const st = loadRunState(runDir);
    expect(st.verify).toBeUndefined();
    expect(st.verify_rejections ?? 0).toBe(0);

    // a recover while already cancelled also ends cancelled and judges nothing
    const ac2 = new AbortController();
    ac2.abort();
    const again = await runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, log: () => {}, signal: ac2.signal, invoker: async () => OK });
    expect(again.endReason).toBe("cancelled");
    expect(fs.readdirSync(outbox).filter((f) => f.endsWith(".md"))).toHaveLength(1);

    // resume without cancel: the same done is verified again
    env.editProjectYaml((t) => t.replace("sleep 60", "true"));
    const done = await runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, log: () => {}, invoker: async () => {
      calls.n++;
      return OK;
    } });
    expect(done.outcome).toBe("completed");
    expect(calls.n).toBe(1); // the lead was not woken again: the done was already there
    expect(loadRunState(runDir).verify).toHaveLength(1);
  });

  /** The run crashes at `step` with a failed verification, is resumed, and the lead answers the rejection with a fresh done. */
  const crashAt = async (step: string) => {
    env = makeEnv();
    withVerify([{ name: "test", run: "echo bad; exit 1" }], 1);
    const { project, runDir, task } = start();
    setFaultHook((s) => {
      if (s === step) throw new Error("crash");
    });
    const calls = { n: 0 };
    const atSecondWake: { prompt?: string; rejections?: number; result?: boolean; archive?: boolean } = {};
    const lead: Invoker = async (i) => {
      calls.n++;
      if (calls.n === 2) {
        // the replayed rejection reached the lead before any verdict was accepted
        atSecondWake.prompt = i.userPrompt;
        atSecondWake.rejections = loadRunState(runDir).verify_rejections;
        atSecondWake.result = fs.existsSync(path.join(runDir, "result.md"));
        atSecondWake.archive = fs.existsSync(path.join(runDir, "done-1.md"));
      }
      sendDone(i); // call 1: the first done; call 2: a fresh one
      return OK;
    };
    await expect(runTeam({ project, task, runDir, log: () => {}, invoker: lead })).rejects.toThrow("crash");
    setFaultHook(undefined);
    const resumed = await runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, log: () => {}, invoker: lead });
    return { runDir, resumed, st: loadRunState(runDir), calls, atSecondWake };
  };

  it.each(["verify:counted", "verify:sent"])("a crash at %s, replayed: counted once, sent once; a later fresh failure at full budget is partial", async (step) => {
    const { runDir, resumed, st, calls, atSecondWake } = await crashAt(step);
    expect(calls.n).toBe(2);
    // the replay sent the rejection back (not accepted as partial), counted once
    expect(atSecondWake.prompt).toContain("failed verification");
    expect(atSecondWake.rejections).toBe(1);
    expect(atSecondWake.result).toBe(false);
    expect(atSecondWake.archive).toBe(false);
    expect(mailWith(runDir, "Your done report failed verification")).toHaveLength(1);
    // the fresh done fails with the budget (1) used: only now it is partial
    expect(resumed.endReason).toBe("done");
    expect(resumed.outcome).toBe("partial");
    expect(resumed.outcomeNote).toContain("Verification failed after 1 rejection(s)");
    expect(st.verify_rejections).toBe(1);
    expect(st.verify_rejected).toHaveLength(1);
    // original run, replay, fresh done: three records, all kept
    expect(st.verify).toHaveLength(3);
    expect(st.verify!.every((r) => !r.passed)).toBe(true);
  });
});

describe("reopen", () => {
  it("a follow-up is verified again; the earlier result and counters are reset or kept as specified", async () => {
    env = makeEnv();
    const flag = path.join(env.root, "fixed");
    withVerify([{ name: "test", run: `if [ -f ${flag} ]; then exit 0; fi; exit 1` }], 1);
    const { project, runDir, task } = start();
    let k = 0;
    const lead: Invoker = async (i) => {
      k++;
      if (k === 2) fs.writeFileSync(flag, "1");
      sendDone(i);
      return OK;
    };
    const first = await runTeam({ project, task, runDir, log: () => {}, invoker: lead });
    expect(first.outcome).toBe("completed");
    expect(loadRunState(runDir).verify_rejections).toBe(1);
    fs.rmSync(flag);
    const second = await runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, log: () => {}, followup: { text: "more" }, invoker: async (i) => {
      sendDone(i);
      return OK;
    } });
    expect(second.endReason).toBe("done");
    expect(second.outcome).toBe("partial"); // the counter was reset at reopen: one rejection again, then partial
    const st = loadRunState(runDir);
    expect(st.verify!.length).toBeGreaterThanOrEqual(3);
    expect(st.verify![0]!.passed).toBe(false);
    expect(fs.readFileSync(path.join(runDir, "done-1.md"), "utf8")).toContain("all commands passed");
    expect(fs.readFileSync(path.join(runDir, "done-2.md"), "utf8")).toContain("Dispatcher verification");
  });
});

describe("status and doctor", () => {
  it("status --json is the same with and without verify records; the text shows the last verification", async () => {
    env = makeEnv();
    withVerify([{ name: "test", run: "true" }]);
    const { project, runDir, task } = start();
    await runTeam({ project, task, runDir, log: () => {}, invoker: async (i) => {
      sendDone(i);
      return OK;
    } });
    const state = loadRunState(runDir);
    const withV = buildRunReport({ dir: runDir, state }, project);
    const { verify: _v, ...rest } = state;
    const without = buildRunReport({ dir: runDir, state: rest as typeof state }, project);
    expect(JSON.stringify(withV)).toBe(JSON.stringify(without));
    expect(JSON.stringify(withV)).not.toContain("verify");
    const marked = { ...state, verify: state.verify!.map((r) => ({ ...r, repeat_stop_segment: 0, commands: r.commands.map((c) => ({ ...c, fingerprint: "0123456789abcdef" })) })) };
    expect(JSON.stringify(buildRunReport({ dir: runDir, state: marked }, project))).toBe(JSON.stringify(withV));
    const text = formatStatusReport({ project: project.name, agents: [], run: withV } as never);
    expect(text).toMatch(/dispatcher 驗證：\s*通過/);
  });

  it("doctor lists each command and warns that they run outside the sandbox", async () => {
    const { diagnoseProject } = await import("../src/doctor.js");
    env = makeEnv();
    withVerify([{ name: "test", run: "npm test", timeout_sec: 900 }], 3);
    const r = await diagnoseProject(env.project(), { env: { PATH: "" } });
    const c = r.checks.find((x) => x.subject === "verify");
    expect(c?.level).toBe("warn");
    expect(c?.message).toContain("test: npm test (timeout 900s)");
    expect(c?.message).toContain("OUTSIDE the agents' sandbox");
    env.editProjectYaml((t) => t.slice(0, t.indexOf("\nverify:")));
    expect((await diagnoseProject(env.project(), { env: { PATH: "" } })).checks.some((x) => x.subject === "verify")).toBe(false);
  });
});

describe("tree hash is bounded and runs no hooks", () => {
  const hookRepo = () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const hook = path.join(env.repo, ".git", "hooks", "post-index-change");
    write(hook, `#!/bin/sh\necho called >> ${JSON.stringify(path.join(env.root, "hook-called"))}\nsleep 5\n`);
    fs.chmodSync(hook, 0o755);
    return env.project();
  };
  it("non-worktree mode: the hook is not run and the hash comes back quickly", async () => {
    const project = hookRepo();
    const t = Date.now();
    const h = await workingTreeHash(project);
    expect(h).toMatch(/^[0-9a-f]{40}$/);
    expect(Date.now() - t).toBeLessThan(4000);
    expect(fs.existsSync(path.join(env.root, "hook-called"))).toBe(false);
  });
  it("a slow clean filter is cut at the deadline: no hash, and nothing is left running", async () => {
    const project = hookRepo();
    write(path.join(env.repo, ".gitattributes"), "* filter=slow\n");
    const started = path.join(env.root, "filter-started");
    const survived = path.join(env.root, "filter-survived");
    execFileSync("git", ["-C", env.repo, "config", "filter.slow.clean", `sh -c 'touch ${started}; sleep 1.5; touch ${survived}'`]);
    const t = Date.now();
    expect(await workingTreeHash(project, undefined, { timeoutMs: 500 })).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(3000);
    expect(fs.existsSync(started)).toBe(true);
    await new Promise((r) => setTimeout(r, 2000)); // the filter would have finished by now had it not been killed
    expect(fs.existsSync(survived)).toBe(false);
  });
  it("an abort is delivered while hashing and gives no hash", async () => {
    const project = hookRepo();
    write(path.join(env.repo, ".gitattributes"), "* filter=slow\n");
    execFileSync("git", ["-C", env.repo, "config", "filter.slow.clean", "sleep 30"]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t = Date.now();
    expect(await workingTreeHash(project, undefined, { signal: ac.signal })).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("cancel during a timeout's cleanup, in a run", () => {
  it("ends cancelled with no verdict and the done kept", async () => {
    env = makeEnv();
    withVerify([{ name: "slow", run: "trap '' TERM; sleep 60 & wait", timeout_sec: 1 }], 0);
    const { project, runDir, task } = start();
    const ac = new AbortController();
    const log = (t: string) => {
      if (t.includes("verifying ")) setTimeout(() => ac.abort(), 1200);
    };
    const s = await runTeam({ project, task, runDir, log, signal: ac.signal, verifyTiming: { killGraceMs: 1000, settleWaitMs: 100 }, invoker: async (i) => {
      sendDone(i);
      return OK;
    } });
    expect(s.endReason).toBe("cancelled");
    expect(loadRunState(runDir).verify).toBeUndefined();
    expect(fs.existsSync(path.join(runDir, "result.md"))).toBe(false);
    expect(fs.readdirSync(outboxDir(bindRunProject(project, runDir, "run"), project.lead)).filter((f) => f.endsWith(".md"))).toHaveLength(1);
  });
});

describe("run epilogue and temp index lock", () => {
  const print = async (summary: Parameters<typeof import("../src/run-print.js").printRun>[0], runDir: string) => {
    const { printRun } = await import("../src/run-print.js");
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      printRun(summary, runDir);
    } finally {
      spy.mockRestore();
    }
    return lines.join("\n");
  };
  const done = async (cmds: { name: string; run: string }[] | undefined, max = 0) => {
    env = makeEnv();
    if (cmds) withVerify(cmds, max);
    const { project, runDir, task } = start();
    const s = await runTeam({ project, task, runDir, log: () => {}, invoker: async (i) => {
      sendDone(i);
      return OK;
    } });
    return { s, runDir, project };
  };
  it("without verify the output is the old line and there is no dispatcher field", async () => {
    const { s, runDir } = await done(undefined);
    expect(s.dispatcherVerification).toBeUndefined();
    const out = await print(s, runDir);
    expect(out).toContain("Verification (as reported by the lead, not checked by agent-lyceum): npm test: passed");
    expect(out).not.toContain("Dispatcher verification");
  });
  it("a passed verification is printed beside the lead's own text, labelled as the lead's", async () => {
    const { s, runDir } = await done([{ name: "t", run: "true" }]);
    const out = await print(s, runDir);
    expect(out).toContain("Verification (the lead's own report): npm test: passed");
    expect(out).not.toContain("not checked by agent-lyceum");
    expect(out).toContain("Dispatcher verification (run by agent-lyceum): passed (t)");
  });
  it("a failed verification names the command", async () => {
    const { s, runDir } = await done([{ name: "t", run: "exit 4" }]);
    const out = await print(s, runDir);
    expect(out).toContain("Dispatcher verification (run by agent-lyceum): FAILED: t (exit 4) exited with code 4");
    expect(s.outcome).toBe("partial");
  });
  it("status --json report is unchanged by the summary field", async () => {
    const { runDir, project } = await done([{ name: "t", run: "true" }]);
    expect(JSON.stringify(buildRunReport({ dir: runDir, state: loadRunState(runDir) }, project))).not.toContain("Dispatcher verification");
  });
  it("a hash cut at the deadline leaves no temporary index or lock behind", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    write(path.join(env.repo, ".gitattributes"), "* filter=slow\n");
    execFileSync("git", ["-C", env.repo, "config", "filter.slow.clean", "sleep 30"]);
    const tmp = fs.mkdtempSync(path.join(env.root, "tmpdir-"));
    const old = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      expect(await workingTreeHash(env.project(), undefined, { timeoutMs: 500 })).toBeUndefined();
    } finally {
      if (old === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = old;
    }
    // Only this helper's files: Apple Git leaves its own `xcrun_db` in TMPDIR.
    expect(fs.readdirSync(tmp).filter((f) => f.startsWith("agent-lyceum-index-"))).toEqual([]);
  });
});

describe("spec 28: the same failure on an unchanged workspace", () => {
  type Opts = { git?: "commit" | "init"; max?: number; cmd?: string | ((root: string) => string); edit?: (i: WakeInput, k: number) => void; openPr?: boolean };
  const lead = (i: WakeInput) => i.project.workspaces?.lead?.dir ?? "";
  const newFile = (i: WakeInput, k: number) => write(path.join(lead(i), `f${k}.txt`), "x\n");
  const repeats = (runDir: string) => events(runDir).filter((e) => e.event === "verify-repeat");
  const actions = (runDir: string) => repeats(runDir).map((e) => e.action);
  const labelled = (runDir: string) => mailWith(runDir, "Same failure as your last rejected");
  const rejections = (runDir: string) => mailWith(runDir, "Your done report failed verification");
  const setup = (o: Opts) => {
    env = makeEnv();
    if (o.git === "commit") initGitRepo(env.repo);
    else if (o.git === "init") git(env.repo, "init", "-q");
    withVerify([{ name: "test", run: typeof o.cmd === "function" ? o.cmd(env.root) : (o.cmd ?? "echo nope; exit 1") }], o.max);
    return start();
  };
  const go = async (o: Opts) => {
    const { project, runDir, task } = setup(o);
    const calls = { n: 0 };
    const prompts: string[] = [];
    const prCalls: string[][] = [];
    const pr: CommandRunner = (cmd, args) => {
      prCalls.push([cmd, ...args]);
      return { ok: true, out: "" };
    };
    const s = await runTeam({ project, task, runDir, log: () => {}, pr, invoker: async (i) => {
      calls.n++;
      prompts.push(i.userPrompt);
      o.edit?.(i, calls.n);
      sendDone(i, "completed", FULL_DONE, o.openPr ? "open_pr: true\n" : "");
      return OK;
    } });
    return { s, runDir, calls, prompts, prCalls, st: loadRunState(runDir) };
  };

  it("1: same fingerprint and same tree: stopped at the second failure as partial, no rejection used for it", async () => {
    const { s, runDir, calls, prCalls, st } = await go({ git: "commit", max: 2, openPr: true });
    expect(calls.n).toBe(2);
    expect(s.endReason).toBe("done");
    expect(s.outcome).toBe("partial");
    expect(s.outcomeNote).toContain("Verification stopped early");
    expect(s.outcomeNote).toContain("(1 of 2 rejection(s) used)");
    expect(st.verify_rejections).toBe(1);
    expect(st.verify_rejected).toHaveLength(1);
    expect(rejections(runDir)).toHaveLength(1);
    expect(actions(runDir)).toEqual(["none", "stop"]);
    expect(repeats(runDir)[1]).toMatchObject({ hash: "same", same_fingerprint: true, rejections_left: 1 });
    expect(prCalls).toEqual([]);
    expect(fs.readFileSync(path.join(runDir, "result.md"), "utf8")).toContain("NOT all commands passed");
    expect(st.verify!.map((r) => r.repeat_stop_segment)).toEqual([undefined, 0]);
    expect(st.verify![0]!.commands[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("2: same fingerprint, tree changed: sent back with the label, then the limit of spec 27", async () => {
    const { s, runDir, calls, st } = await go({ git: "commit", max: 2, edit: newFile });
    expect(calls.n).toBe(3);
    expect(s.outcome).toBe("partial");
    expect(s.outcomeNote).toContain("Verification failed after 2 rejection(s)");
    expect(s.outcomeNote).not.toContain("stopped early");
    expect(actions(runDir)).toEqual(["none", "label", "limit"]);
    expect(repeats(runDir)[1]).toMatchObject({ hash: "changed" });
    const l = labelled(runDir);
    expect(l).toHaveLength(1);
    expect(fs.readFileSync(l[0]!, "utf8")).toContain("The workspace changed since then, but this result did not.");
    expect(st.verify_rejections).toBe(2);
  });

  it("3: a different fingerprint: no label, only the count", async () => {
    const { s, runDir, calls } = await go({ git: "commit", max: 2, cmd: (root) => `cat ${root}/count; exit 1`, edit: (_i, k) => fs.writeFileSync(path.join(env.root, "count"), `run ${k}\n`) });
    expect(calls.n).toBe(3);
    expect(s.outcomeNote).toContain("Verification failed after 2 rejection(s)");
    expect(labelled(runDir)).toEqual([]);
    expect(repeats(runDir).map((e) => e.same_fingerprint)).toEqual([false, false, false]);
  });

  it("4: fail-fast: a different command failing next is progress", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const flag = path.join(env.root, "a-fixed");
    withVerify([{ name: "a", run: `if [ -f ${flag} ]; then exit 0; fi; echo bad a; exit 1` }, { name: "b", run: "echo bad b; exit 1" }], 2);
    const { project, runDir, task } = start();
    const calls = { n: 0 };
    const s = await runTeam({ project, task, runDir, log: () => {}, invoker: async (i) => {
      if (++calls.n === 2) fs.writeFileSync(flag, "1");
      sendDone(i);
      return OK;
    } });
    expect(s.outcomeNote).toContain("Verification failed after 2 rejection(s)");
    expect(s.outcomeNote).toContain("`b`");
    expect(labelled(runDir)).toEqual([]);
    expect(actions(runDir)).toEqual(["none", "none", "limit"]);
  });

  it.each(["not a git repo", "git repo without a commit"])("5: no lead worktree (%s): the hash is not compared, the count is the only limit", async (kind) => {
    const { s, runDir, calls, st } = await go({ git: kind === "not a git repo" ? undefined : "init", max: 2 });
    if (kind !== "not a git repo") expect(st.verify![0]!.diff_hash).toMatch(/^[0-9a-f]{40}$/); // a hash exists, and is still ignored
    expect(calls.n).toBe(3);
    expect(s.outcomeNote).toContain("Verification failed after 2 rejection(s)");
    expect(actions(runDir)).toEqual(["none", "label", "limit"]);
    expect(repeats(runDir).slice(0, 2).map((e) => e.hash)).toEqual(["no-worktree", "no-worktree"]);
    const l = labelled(runDir);
    expect(l).toHaveLength(1);
    expect(fs.readFileSync(l[0]!, "utf8")).not.toContain("The workspace changed");
  });

  it("6: a worktree whose hash cannot be taken (nested repository): unknown, never the same", async () => {
    const { s, runDir, calls, st } = await go({ git: "commit", max: 2, edit: (i, k) => k === 1 && git(lead(i), "init", "-q", "nested") });
    expect(st.verify![0]!.diff_hash).toBeUndefined();
    expect(calls.n).toBe(3);
    expect(s.outcomeNote).toContain("Verification failed after 2 rejection(s)");
    expect(actions(runDir)).toEqual(["none", "label", "limit"]);
    expect(repeats(runDir)[1]).toMatchObject({ hash: "unknown", same_fingerprint: true });
    expect(fs.readFileSync(labelled(runDir)[0]!, "utf8")).not.toContain("The workspace changed");
  });

  it.each(["verify:counted", "verify:sent"])("7: a replay after a crash at %s does not count twice and does not stop on its own record", async (step) => {
    const { project, runDir, task } = setup({ git: "commit", max: 2 });
    setFaultHook((x) => {
      if (x === step) throw new Error("crash");
    });
    const calls = { n: 0 };
    const at2: { prompt?: string; rejections?: number; result?: boolean } = {};
    const invoker: Invoker = async (i) => {
      calls.n++;
      if (calls.n === 2) {
        at2.prompt = i.userPrompt;
        at2.rejections = loadRunState(runDir).verify_rejections;
        at2.result = fs.existsSync(path.join(runDir, "result.md"));
      }
      sendDone(i);
      return OK;
    };
    await expect(runTeam({ project, task, runDir, log: () => {}, invoker })).rejects.toThrow("crash");
    setFaultHook(undefined);
    const resumed = await runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, log: () => {}, invoker });
    expect(at2.prompt).toContain("failed verification");
    expect(at2.rejections).toBe(1);
    expect(at2.result).toBe(false);
    expect(calls.n).toBe(2);
    expect(rejections(runDir)).toHaveLength(1);
    expect(resumed.outcomeNote).toContain("Verification stopped early");
    const st = loadRunState(runDir);
    expect(st.verify_rejections).toBe(1);
    expect(st.verify).toHaveLength(3);
    expect(actions(runDir)).toEqual(["none", "none", "stop"]); // first, the replay of the same done, the new done
  });

  describe("8: a crash after the stop was stored", () => {
    const cmd = (root: string) => `if [ -f ${root}/fixed ]; then exit 0; fi; if [ -f ${root}/flip ]; then echo different; else echo nope; fi; exit 1`;
    const crashed = async () => {
      env = makeEnv();
      initGitRepo(env.repo);
      withVerify([{ name: "test", run: cmd(env.root) }], 2);
      const { project, runDir, task } = start();
      setFaultHook((x) => {
        if (x === "verify:stopped") throw new Error("crash");
      });
      const calls = { n: 0 };
      const invoker: Invoker = async (i) => {
        calls.n++;
        sendDone(i);
        return OK;
      };
      await expect(runTeam({ project, task, runDir, log: () => {}, invoker })).rejects.toThrow("crash");
      setFaultHook(undefined);
      expect(loadRunState(runDir).verify!.at(-1)!.repeat_stop_segment).toBe(0);
      expect(loadRunState(runDir).end_reason).toBeUndefined();
      return { runDir, project, calls, invoker };
    };
    it("replayed with other output: still stopped, nothing counted, no second mail", async () => {
      const { runDir, calls, invoker } = await crashed();
      fs.writeFileSync(path.join(env.root, "flip"), "1");
      const resumed = await runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, log: () => {}, invoker });
      expect(calls.n).toBe(2);
      expect(resumed.outcome).toBe("partial");
      expect(resumed.outcomeNote).toContain("Verification stopped early");
      const st = loadRunState(runDir);
      expect(st.verify_rejections).toBe(1);
      expect(rejections(runDir)).toHaveLength(1);
      expect(actions(runDir)).toEqual(["none", "stop", "stop"]);
    });
    it("replayed with the command now passing: accepted as completed", async () => {
      const { runDir, invoker } = await crashed();
      fs.writeFileSync(path.join(env.root, "fixed"), "1");
      const resumed = await runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, log: () => {}, invoker });
      expect(resumed.outcome).toBe("completed");
      expect(loadRunState(runDir).verify_rejections).toBe(1);
    });
  });

  it("9: a follow-up starts a new segment: the first failure is sent back, the next repeat stops", async () => {
    const { project, runDir, task } = setup({ git: "commit", max: 2 });
    const invoker: Invoker = async (i) => {
      sendDone(i);
      return OK;
    };
    const first = await runTeam({ project, task, runDir, log: () => {}, invoker });
    expect(first.outcomeNote).toContain("Verification stopped early");
    const second = await runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, log: () => {}, followup: { text: "more" }, invoker });
    expect(second.outcomeNote).toContain("Verification stopped early");
    expect(second.outcomeNote).toContain("(1 of 2 rejection(s) used)");
    const st = loadRunState(runDir);
    expect(st.verify).toHaveLength(4);
    expect(st.verify!.map((r) => r.repeat_stop_segment)).toEqual([undefined, 0, undefined, 1]);
    expect(actions(runDir)).toEqual(["none", "stop", "none", "stop"]);
    expect(st.verify_rejections).toBe(1);
  });

  it("10: records written before spec 28 (no fingerprint) never match", async () => {
    const { project, runDir, task } = setup({ git: "commit", max: 2 });
    setFaultHook((x) => {
      if (x === "verify:sent") throw new Error("crash");
    });
    const calls = { n: 0 };
    const invoker: Invoker = async (i) => {
      calls.n++;
      sendDone(i);
      return OK;
    };
    await expect(runTeam({ project, task, runDir, log: () => {}, invoker })).rejects.toThrow("crash");
    setFaultHook(undefined);
    // the done is set aside as the crashed process would have done next; the record loses its fingerprint like one from an older version
    const outbox = outboxDir(bindRunProject(project, runDir, "run"), project.lead);
    for (const f of fs.readdirSync(outbox).filter((x) => x.endsWith(".md"))) rejectDone(path.join(outbox, f));
    const old = loadRunState(runDir);
    for (const r of old.verify!) for (const c of r.commands) delete c.fingerprint;
    saveRunState(runDir, old);
    const resumed = await runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, log: () => {}, invoker });
    expect(calls.n).toBe(3);
    expect(resumed.outcomeNote).toContain("Verification failed after 2 rejection(s)");
    expect(labelled(runDir)).toEqual([]);
    expect(actions(runDir)).toEqual(["none", "none", "limit"]);
  });

  it.each([
    [0, ["limit"], 1],
    [1, ["none", "limit"], 2],
  ])("11: max_rejections %i keeps the text of spec 27 and never stops early", async (max, acts, wakes) => {
    const { s, runDir, calls } = await go({ git: "commit", max });
    expect(calls.n).toBe(wakes);
    expect(s.outcomeNote).toMatch(new RegExp(`^Verification failed after ${max} rejection\\(s\\): \`test\` \\(\`echo nope; exit 1\`\\) exited with code 1; see verify/\\d+-test\\.log\\. Reported as partial; the lead's report is kept as written\\.$`));
    expect(actions(runDir)).toEqual(acts);
  });

  it("12: with unintegrated work the outcome stays blocked and the note carries both reasons", async () => {
    const { resolveDoneOutcome } = await import("../src/run-outcome.js");
    const note = repeatStopNote("test", "npm test", "exited with code 1", "verify/2-test.log", 1, 2);
    const r = resolveDoneOutcome({ missing: [], outcome: "completed" } as never, 0, [{ agent: "fe", branch: "b", report: "r.md" }], { note });
    expect(r.outcome).toBe("blocked");
    expect(r.note).toContain("never brought into the repo");
    expect(r.note).toContain("Verification stopped early");
  });

  describe("16: a done left in the outbox of an ended segment enters the next one", () => {
    it.each(["unchanged", "changed"])("%s workspace", async (kind) => {
      const { project, runDir, task } = setup({ git: "commit", max: 2 });
      setFaultHook((x) => {
        if (x === "run:ended") throw new Error("crash");
      });
      const calls = { n: 0 };
      const at3: { prompt?: string; rejections?: number; rejected?: string[] } = {};
      const invoker: Invoker = async (i) => {
        calls.n++;
        if (calls.n === 3) {
          at3.prompt = i.userPrompt;
          at3.rejections = loadRunState(runDir).verify_rejections;
          at3.rejected = loadRunState(runDir).verify_rejected;
          if (kind === "changed") newFile(i, 3);
        }
        sendDone(i);
        return OK;
      };
      await expect(runTeam({ project, task, runDir, log: () => {}, invoker })).rejects.toThrow("crash");
      setFaultHook(undefined);
      const ended = loadRunState(runDir);
      expect(ended.end_reason).toBe("done");
      expect(ended.verify!.map((r) => r.repeat_stop_segment)).toEqual([undefined, 0]);
      const resumed = await runTeam({ project: env.project(), resume: ended, runDir, log: () => {}, followup: { text: "more please" }, invoker });
      const st = loadRunState(runDir);
      expect(calls.n).toBe(kind === "changed" ? 4 : 3);
      expect(at3.prompt).toContain("more please");
      expect(at3.prompt).toContain("failed verification");
      expect(at3.rejections).toBe(1);
      expect(at3.rejected).toHaveLength(1);
      expect(at3.rejected![0]).toBe(ended.verify![1]!.source); // the old done, judged afresh in the new segment
      expect(st.verify).toHaveLength(kind === "changed" ? 5 : 4);
      expect(st.verify![2]!.source).toBe(st.verify![1]!.source);
      expect(labelled(runDir).length).toBe(kind === "changed" ? 1 : 0);
      if (kind === "unchanged") {
        expect(resumed.outcome).toBe("partial");
        expect(resumed.outcomeNote).toContain("Verification stopped early");
        expect(resumed.outcomeNote).toContain("1 of 2");
        expect(rejections(runDir)).toHaveLength(2);
        expect(st.verify!.map((r) => r.repeat_stop_segment)).toEqual([undefined, 0, undefined, 1]);
        expect(actions(runDir)).toEqual(["none", "stop", "none", "stop"]);
      } else {
        expect(resumed.outcomeNote).toContain("Verification failed after 2 rejection(s)");
        expect(actions(runDir).slice(2)).toEqual(["none", "label", "limit"]);
      }
    });
  });
});

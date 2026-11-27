import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import { outboxDir } from "../src/policy.js";
import { RunSession, type RunSummary } from "../src/run-session.js";
import { loadRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import type { WorkspacePlan } from "../src/worktree.js";
import { FULL_DONE, git, initGitRepo, makeEnv, withSections, write, type TestEnv } from "./helpers.js";

// A checkout run: the lead works in the project checkout on its own branch. The checkout is only committed, snapshotted for
// members, and written to while HEAD is still that branch.

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const BR = "agent-lyceum/run-1/lead";
const ASK = `<ask><question id="q1"><text>JWT?</text><options><option>session</option><option>jwt</option></options><suggested>session</suggested></question></ask>`;

const mail = (i: WakeInput, to: string, type: string, subject: string, body = "") =>
  write(
    path.join(outboxDir(i.project, i.agent.name), `${Math.random()}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${type === "done" ? FULL_DONE : type === "ask" ? body : withSections(type, body || `body of ${subject}`)}\n`,
  );

/** A repo on `main`, and a checkout run of it that has already cut its branch (the lead's HEAD is `branch`). */
function setup(opts: { branch?: string; lead?: string; verify?: string } = {}) {
  env = makeEnv();
  initGitRepo(env.repo);
  const sha = git(env.repo, "rev-parse", "HEAD");
  if (opts.lead) env.editProjectYaml((t) => t.replace("lead: lead", `lead: ${opts.lead}`));
  if (opts.verify) env.editProjectYaml((t) => `${t}\nverify:\n  max_rejections: 2\n  commands:\n    - { name: test, run: ${JSON.stringify(opts.verify)} }\n`);
  const branch = opts.branch ?? BR;
  const project = env.project();
  const runDir = path.join(project.paths.runs, "run-1");
  const task = prepareTask({ text: "build the thing", cwd: env.root, runDir });
  const plan: WorkspacePlan = { mode: "worktree", leadWorktree: false, taskBranch: branch, baseRef: "origin/main", baseSha: sha, checkoutFrom: "main" };
  const lines: string[] = [];
  const go = async (invoker: Invoker): Promise<RunSummary> => {
    const session = new RunSession({ project, plan, task, runDir, startCheckout: true, log: (l) => lines.push(l), invoker, verifyTiming: { killGraceMs: 100, settleWaitMs: 100 } });
    return session.run();
  };
  return { sha, runDir, lines, go, branch, project };
}
const headBranch = () => git(env.repo, "branch", "--show-current");
const events = (runDir: string): { event: string; [k: string]: unknown }[] =>
  fs.readFileSync(path.join(runDir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("a checkout run that keeps its HEAD", () => {
  it("brings a member's files into the checkout, commits the lead's work on the task branch, and prints git merge <task_branch>", async () => {
    const { sha, runDir, lines, go } = setup();
    let leadCalls = 0;
    const s = await go(async (i) => {
      if (i.agent.name === "lead") {
        if (++leadCalls === 1) mail(i, "fe-member", "task", "job");
        else mail(i, "lead", "done", "bye");
      } else {
        write(path.join(i.workspace!.dir, "src/web/feature.txt"), "member built\n");
        mail(i, "lead", "reply", "finished");
      }
      return OK;
    });
    expect(s.endReason).toBe("done");
    expect(headBranch()).toBe(BR);
    expect(s.resultBranch).toMatchObject({ branch: BR, base: sha, files: 1 });
    expect(git(env.repo, "rev-parse", "main")).toBe(sha);
    expect(git(env.repo, "show", `${BR}:src/web/feature.txt`)).toBe("member built");
    expect(loadRunState(runDir).result_branch).toMatchObject({ branch: BR, files: 1 });
    expect(lines.join("\n")).toContain(`git merge ${BR}`);
    expect(git(env.repo, "status", "--porcelain")).toBe("");
  });

  it("the merge command names the recorded task_branch, not a branch rebuilt from the current lead", async () => {
    const { lines, go } = setup({ branch: "agent-lyceum/run-1/old-lead", lead: "fe-member" });
    const s = await go(async (i) => {
      write(path.join(env.repo, "src/web/lead.txt"), "lead\n");
      mail(i, i.agent.name, "done", "bye");
      return OK;
    });
    expect(s.resultBranch?.branch).toBe("agent-lyceum/run-1/old-lead");
    expect(lines.join("\n")).toContain("git merge agent-lyceum/run-1/old-lead");
    expect(lines.join("\n")).not.toContain("agent-lyceum/run-1/fe-member");
  });

  it("waiting commits nothing: the lead's file stays uncommitted and there is no result_branch", async () => {
    const { sha, runDir, go } = setup();
    const s = await go(async (i) => {
      write(path.join(env.repo, "src/web/lead.txt"), "lead\n");
      mail(i, "lead", "ask", "q", ASK);
      return OK;
    });
    expect(s.endReason).toBe("waiting");
    expect(s.resultBranch).toBeUndefined();
    expect(loadRunState(runDir).result_branch).toBeUndefined();
    expect(git(env.repo, "rev-parse", BR)).toBe(sha);
    expect(git(env.repo, "status", "--porcelain")).toContain("src/web/lead.txt");
  });
});

describe("HEAD moved off the task branch", () => {
  it("before the members' snapshot: the run ends lead_failed without spinning, and nothing is committed", async () => {
    const { sha, runDir, go } = setup();
    const woken: string[] = [];
    const s = await go(async (i) => {
      woken.push(i.agent.name);
      if (i.agent.name === "lead") {
        write(path.join(env.repo, "src/web/lead.txt"), "lead\n");
        git(env.repo, "stash", "-u", "-q");
        git(env.repo, "checkout", "-q", "main");
        git(env.repo, "stash", "pop", "-q");
        mail(i, "fe-member", "task", "job");
      }
      return OK;
    });
    expect(s.endReason).toBe("lead_failed");
    expect(s.rounds).toBe(1); // only the lead's own wake-up: the break did not loop through more rounds
    expect(woken).toEqual(["lead"]);
    expect(s.resultBranch).toBeUndefined();
    expect(loadRunState(runDir).result_branch).toBeUndefined();
    expect(loadRunState(runDir).notes?.join("\n")).toContain(BR);
    expect(git(env.repo, "rev-parse", "main")).toBe(sha); // no commit on main
    expect(git(env.repo, "rev-parse", BR)).toBe(sha);
  });

  it("after the member finished and before its work is integrated: the member is blocked, the lead is told, and main is not written", async () => {
    const { sha, runDir, go } = setup();
    let leadCalls = 0;
    let leadPrompt = "";
    const s = await go(async (i) => {
      if (i.agent.name === "lead") {
        if (++leadCalls === 1) mail(i, "fe-member", "task", "job");
        else {
          leadPrompt = i.userPrompt;
          mail(i, "lead", "done", "bye");
        }
      } else {
        write(path.join(i.workspace!.dir, "src/web/feature.txt"), "member built\n");
        git(env.repo, "checkout", "-q", "main"); // the checkout is moved while the member works
        mail(i, "lead", "reply", "finished");
      }
      return OK;
    });
    expect(s.endReason).toBe("done");
    const blocked = loadRunState(runDir).blocked_integrations ?? [];
    expect(blocked.map((b) => b.agent)).toEqual(["fe-member"]);
    expect(blocked[0]?.reason).toContain(BR);
    expect(leadPrompt).toMatch(/could not be brought into the repo/);
    expect(fs.existsSync(path.join(env.repo, "src/web/feature.txt"))).toBe(false);
    expect(git(env.repo, "rev-parse", "main")).toBe(sha);
    expect(git(env.repo, "rev-list", "--count", "main")).toBe("1");
    expect(s.resultBranch).toBeUndefined(); // HEAD is still main at the end: nothing committed there either
  });

  it("at the end: no commit on main and no result_branch, only a note", async () => {
    const { sha, runDir, go } = setup();
    const s = await go(async (i) => {
      write(path.join(env.repo, "src/web/lead.txt"), "lead\n");
      git(env.repo, "stash", "-u", "-q");
      git(env.repo, "checkout", "-q", "main");
      git(env.repo, "stash", "pop", "-q");
      mail(i, "lead", "done", "bye");
      return OK;
    });
    expect(s.endReason).toBe("done");
    expect(s.resultBranch).toBeUndefined();
    expect(loadRunState(runDir).result_branch).toBeUndefined();
    expect(loadRunState(runDir).notes?.join("\n")).toMatch(new RegExp(`not committed.*${BR}|${BR}.*not committed`, "s"));
    expect(git(env.repo, "rev-parse", "main")).toBe(sha);
    expect(git(env.repo, "status", "--porcelain")).toContain("src/web/lead.txt");
  });
});

describe("verify in a checkout run", () => {
  it("a repeated failure does not stop early: there is no lead worktree, so the hash is not compared (no-worktree)", async () => {
    const { runDir, go } = setup({ verify: "echo nope; exit 1" });
    let calls = 0;
    const s = await go(async (i) => {
      calls++;
      mail(i, "lead", "done", `bye ${calls}`);
      return OK;
    });
    expect(calls).toBe(3);
    expect(s.outcomeNote).toContain("Verification failed after 2 rejection(s)");
    const repeats = events(runDir).filter((e) => e.event === "verify-repeat");
    expect(repeats.map((e) => e.action)).toEqual(["none", "label", "limit"]);
    expect(repeats.slice(0, 2).map((e) => e.hash)).toEqual(["no-worktree", "no-worktree"]);
    expect(headBranch()).toBe(BR);
  });
});

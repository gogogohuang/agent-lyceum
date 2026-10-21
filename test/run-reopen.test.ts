import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { outboxDir } from "../src/policy.js";
import { loadRunState, saveRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import type { CommandRunner } from "../src/open-pr.js";
import { FULL_DONE, git, initGitRepo, makeConcurrent, makeEnv, withSections, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const send = (i: WakeInput, to: string, type: string, subject: string, body?: string) =>
  write(
    path.join(outboxDir(i.project, i.agent.name), `${Date.now()}-${Math.random()}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${body ?? (type === "done" ? FULL_DONE.replace("Shipped.", subject) : withSections(type, `body of ${subject}`))}\n`,
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

  it("a run finished before done-<n>.md existed keeps its old report: result.md is copied to done-1.md on reopen", async () => {
    env = makeEnv();
    const { project, runDir } = await first(leadDone("first result"));
    fs.rmSync(path.join(runDir, "done-1.md"));
    fs.writeFileSync(path.join(runDir, "result.md"), "OLD REPORT\n");
    let seen = "";
    await runTeam({
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
    expect(fs.readFileSync(path.join(runDir, "done-1.md"), "utf8")).toContain("OLD REPORT");
    expect(seen).toContain(path.join(runDir, "done-1.md"));
    expect(fs.readFileSync(path.join(runDir, "done-2.md"), "utf8")).toContain("second result");
  });

  it("counts the round limit from the reopen, so a run that used all its rounds can be reopened", async () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("max_rounds: 0 ", "max_rounds: 2 "));
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
    env.editProjectYaml((t) => t.replace("max_rounds: 0 ", "max_rounds: 30 "));
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

  it("gives a reopened segment fresh done reminders but keeps unresolved blocked integrations", async () => {
    env = makeEnv();
    let n = 0;
    // the first done breaks the completion contract (no sections) and goes back once; the second conforms
    const { project, runDir } = await first(async (i) => {
      if (++n === 1) send(i, i.agent.name, "done", "too thin", "just done");
      else send(i, i.agent.name, "done", "first result");
      return OK;
    });
    const st1 = loadRunState(runDir);
    expect(st1.end_reason).toBe("done");
    expect(st1.done_rejections).toBe(1);
    const blocked = [{ agent: "fe-member", branch: "agent-lyceum/x", reason: "conflict", report: "r.md" }];
    saveRunState(runDir, { ...st1, blocked_integrations: blocked });

    await runTeam({ project, resume: loadRunState(runDir), runDir, log: () => {}, followup: { text: "More" }, invoker: leadDone("second result") });
    const st = loadRunState(runDir);
    expect(st.done_rejections ?? 0).toBe(0);
    expect(st.blocked_integrations).toEqual(blocked);
  });

  it("keeps the earlier steps in the progress and adds the follow-up's steps after them", async () => {
    env = makeEnv();
    const steps = (...s: string[]) => `\n\n## Steps\n${s.join("\n")}\n`;
    const { project, runDir } = await first(async (i) => {
      send(i, i.agent.name, "done", "first", FULL_DONE + steps("- [x] login form", "- [x] session"));
      return OK;
    });
    let seen = "";
    await runTeam({
      project,
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      followup: { text: "Also add rate limiting" },
      invoker: async (i) => {
        seen = i.userPrompt;
        send(i, i.agent.name, "done", "second", FULL_DONE + steps("- [x] rate limiter", "- [x] tests"));
        return OK;
      },
    });
    expect(seen).toContain("only this follow-up's steps");
    const st = loadRunState(runDir);
    expect(st.end_reason).toBe("done");
    expect(st.steps).toEqual([
      { text: "login form", done: true },
      { text: "session", done: true },
      { text: "rate limiter", done: true },
      { text: "tests", done: true },
    ]);
  });

  it("an earlier step left open does not block the follow-up's completed done, and a re-listed step is not doubled", async () => {
    env = makeEnv();
    const steps = (...s: string[]) => `\n\n## Steps\n${s.join("\n")}\n`;
    const { project, runDir } = await first(async (i) => {
      write(
        path.join(outboxDir(i.project, i.agent.name), "d.md"),
        `---\nto: ${i.agent.name}\ntype: done\nsubject: first\noutcome: partial\n---\n\n## Result\nhalf\n\n## Not done\ndocs${steps("- [x] login form", "- [ ] docs")}`,
      );
      return OK;
    });
    expect(loadRunState(runDir).end_reason).toBe("done");
    let rejected = false;
    await runTeam({
      project,
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      followup: { text: "Rate limiting" },
      invoker: async (i) => {
        if (i.userPrompt.includes("was not accepted")) rejected = true;
        send(i, i.agent.name, "done", "second", FULL_DONE + steps("- [x] login form", "- [x] rate limiter"));
        return OK;
      },
    });
    expect(rejected).toBe(false);
    expect(loadRunState(runDir).steps).toEqual([
      { text: "login form", done: true },
      { text: "docs", done: false },
      { text: "rate limiter", done: true },
    ]);
  });
});

describe("reopening a concurrent run", () => {
  const BRANCH = "agent-lyceum/run-1/lead";
  const concurrentFirst = async (file: string) => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "Build login", cwd: env.root, runDir });
    const summary = await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      invoker: async (i) => {
        write(path.join(i.workspace!.dir, file), "one\n");
        send(i, i.agent.name, "done", "first result", FULL_DONE.replace("Shipped.", "first result"));
        return OK;
      },
    });
    return { project, runDir, summary };
  };
  const reopen = (project: ReturnType<TestEnv["project"]>, runDir: string, invoker: Invoker, pr?: CommandRunner, say: (s: string) => void = () => {}) =>
    runTeam({ project, resume: loadRunState(runDir), runDir, log: say, followup: { text: "More" }, pr, invoker });

  it("after the lead branch was merged, the worktree is recut from HEAD and the old work is no change of the new branch", async () => {
    const { project, runDir } = await concurrentFirst("src/web/one.txt");
    git(env.repo, "merge", "-q", "--no-edit", BRANCH);
    const head = git(env.repo, "rev-parse", "HEAD");
    let base = "";
    const lines: string[] = [];
    const s = await reopen(project, runDir, async (i) => {
      base = i.workspace!.base;
      write(path.join(i.workspace!.dir, "src/web/two.txt"), "two\n");
      send(i, i.agent.name, "done", "second result");
      return OK;
    }, undefined, (l) => lines.push(l));
    expect(base).toBe(head);
    expect(lines.join("\n")).toContain("already merged");
    expect(s.resultBranch).toMatchObject({ branch: BRANCH, base: head, files: 1 });
    expect(git(env.repo, "diff", "--name-only", head, s.resultBranch!.head)).toBe("src/web/two.txt");
    expect(git(env.repo, "rev-parse", "HEAD")).toBe(head);
  });

  it("before the branch is merged, the same worktree and branch carry on", async () => {
    const { project, runDir, summary } = await concurrentFirst("src/web/one.txt");
    let dir = "";
    let base = "";
    const s = await reopen(project, runDir, async (i) => {
      dir = i.workspace!.dir;
      base = i.workspace!.base;
      write(path.join(dir, "src/web/two.txt"), "two\n");
      send(i, i.agent.name, "done", "second result");
      return OK;
    });
    expect(base).toBe(summary.resultBranch!.base);
    expect(s.resultBranch).toMatchObject({ branch: BRANCH, base: summary.resultBranch!.base, files: 2 });
    expect(git(env.repo, "ls-tree", "--name-only", BRANCH, "src/web/")).toBe("src/web/a.txt\nsrc/web/one.txt\nsrc/web/two.txt");
    expect(git(env.repo, "log", "--format=%s", `${summary.resultBranch!.head}..${BRANCH}`)).toMatch(/lead's work/);
  });

  const reopenWithPr = async (merged: boolean, again = true, prState = "OPEN") => {
    const calls: string[][] = [];
    let created = 0;
    const ok: CommandRunner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "gh" && args[1] === "view") return { ok: true, out: `${prState}\n` };
      return cmd === "gh" ? { ok: true, out: `https://x/pull/${++created + 2}\n` } : { ok: true, out: args[0] === "symbolic-ref" ? "origin/main" : "" };
    };
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const ask = (i: WakeInput, body: string, openPr = true) =>
      write(path.join(outboxDir(i.project, i.agent.name), `${Math.random()}.md`), `---\nto: ${i.agent.name}\ntype: done\nsubject: bye\noutcome: completed\n${openPr ? "open_pr: true\n" : ""}---\n\n${body}\n`);
    await runTeam({
      project,
      task: prepareTask({ text: "go", cwd: env.root, runDir }),
      runDir,
      log: () => {},
      pr: ok,
      invoker: async (i) => {
        write(path.join(i.workspace!.dir, "src/web/one.txt"), "one\n");
        ask(i, FULL_DONE);
        return OK;
      },
    });
    expect(loadRunState(runDir).pr_url).toBe("https://x/pull/3");
    expect(calls.some((c) => c[0] === "gh")).toBe(true);
    if (merged) git(env.repo, "merge", "-q", "--no-edit", BRANCH);
    calls.length = 0;
    const lines: string[] = [];
    const s = await reopen(project, runDir, async (i) => {
      write(path.join(i.workspace!.dir, "src/web/two.txt"), "two\n");
      ask(i, FULL_DONE, again);
      return OK;
    }, ok, (l) => lines.push(l));
    return { s, calls, lines, runDir, project, ok };
  };

  it("a reopened run that already has a PR only pushes when the lead asks for one again", async () => {
    const { s, calls, lines, runDir } = await reopenWithPr(false);
    expect(calls.map((c) => `${c[0]} ${c[1]} ${c[2]}`)).toEqual(["gh pr view", "git push -u"]);
    expect(s.pr).toEqual({ status: "opened", url: "https://x/pull/3", updated: true });
    expect(lines.join("\n")).toContain("pull request updated: https://x/pull/3");
    expect(loadRunState(runDir).pr_url).toBe("https://x/pull/3");
  });

  it("after a squash merge (branch not recut) the recorded PR is merged: a new one is opened and the old url is noted", async () => {
    const { s, calls, runDir } = await reopenWithPr(false, true, "MERGED");
    expect(calls.map((c) => `${c[0]} ${c[1]}`)).toEqual(["gh pr", "git symbolic-ref", "git push", "gh pr"]);
    expect(s.pr).toEqual({ status: "opened", url: "https://x/pull/4" });
    const st = loadRunState(runDir);
    expect(st.pr_url).toBe("https://x/pull/4");
    expect(st.notes?.join("\n")).toMatch(/https:\/\/x\/pull\/3 was no longer open/);
  });

  it("after a recut the old PR belongs to the merged branch: a new one is opened and the old url is noted", async () => {
    const { s, calls, runDir } = await reopenWithPr(true);
    expect(calls.map((c) => `${c[0]} ${c[1]}`)).toEqual(["git symbolic-ref", "git push", "gh pr"]);
    expect(s.pr).toEqual({ status: "opened", url: "https://x/pull/4" });
    const st = loadRunState(runDir);
    expect(st.pr_url).toBe("https://x/pull/4");
    expect(st.notes?.join("\n")).toContain("https://x/pull/3");
    expect(st.notes?.join("\n")).toMatch(/merged branch/);
  });

  it("a recut run that opens no PR keeps no pr_url, so a later reopen on the unmerged branch opens a new PR", async () => {
    const { runDir, project, ok, calls } = await reopenWithPr(true, false);
    const st = loadRunState(runDir);
    expect(st.pr_url).toBeUndefined();
    expect(st.notes?.filter((n) => n.includes("https://x/pull/3"))).toHaveLength(1);
    expect(st.notes?.join("\n")).toMatch(/merged branch/);
    calls.length = 0;
    const lines: string[] = [];
    const s = await reopen(project, runDir, async (i) => {
      write(path.join(i.workspace!.dir, "src/web/three.txt"), "three\n");
      write(path.join(outboxDir(i.project, i.agent.name), `${Math.random()}.md`), `---\nto: ${i.agent.name}\ntype: done\nsubject: bye\noutcome: completed\nopen_pr: true\n---\n\n${FULL_DONE}\n`);
      return OK;
    }, ok, (l) => lines.push(l));
    expect(calls.map((c) => `${c[0]} ${c[1]}`)).toEqual(["git symbolic-ref", "git push", "gh pr"]);
    expect(s.pr).toEqual({ status: "opened", url: "https://x/pull/4" });
    expect(lines.join("\n")).not.toContain("pull request updated");
  });
});

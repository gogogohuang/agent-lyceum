import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WakeInput, WakeResult } from "../src/adapters/index.js";
import { defaultBase, openPullRequest, PR_FOOTER, prBody, prTitle, realRunner, type CommandRunner } from "../src/open-pr.js";
import { outboxDir } from "../src/policy.js";
import { RunSession } from "../src/run-session.js";
import { loadRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { PINNED_CONFIG, type WorkspacePlan } from "../src/worktree.js";
import { FULL_DONE, git, initGitRepo, makeConcurrent, makeEnv, withSections, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
const envs: TestEnv[] = [];
const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "open-pr-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const e of envs.splice(0)) e.cleanup();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

type Call = { cmd: string; args: string[]; cwd: string };
/** A runner that records calls and answers from a table keyed by "cmd arg0 arg1". */
function fake(answers: Record<string, { ok: boolean; out: string }>): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    const key = `${cmd} ${args.slice(0, 2).join(" ")}`;
    return answers[key] ?? { ok: false, out: `unexpected: ${key}` };
  };
  return { run, calls };
}

describe("prTitle / prBody", () => {
  it("takes the first non-empty line of the task summary, at most 72 characters", () => {
    expect(prTitle("\n  add the thing  \nmore")).toBe("add the thing");
    expect(prTitle("x".repeat(100))).toBe(`${"x".repeat(71)}…`);
    expect(prTitle("")).toBe("agent-lyceum task");
  });

  it("is the lead's report followed by one footer line, and nothing else", () => {
    expect(prBody("## Result\nok\n")).toBe(`## Result\nok\n\n${PR_FOOTER}\n`);
    expect(PR_FOOTER).toBe("🤖 Opened by agent-lyceum");
    expect(prBody("a".repeat(70_000)).length).toBeLessThan(61_000);
  });
});

describe("defaultBase", () => {
  it("uses origin/HEAD, then gh, then main", () => {
    const cwd = tmp();
    expect(defaultBase(cwd, fake({ "git symbolic-ref --short": { ok: true, out: "origin/develop" } }).run)).toBe("develop");
    expect(
      defaultBase(cwd, fake({ "git symbolic-ref --short": { ok: false, out: "" }, "gh repo view": { ok: true, out: "trunk" } }).run),
    ).toBe("trunk");
    expect(defaultBase(cwd, fake({}).run)).toBe("main");
  });
});

describe("openPullRequest", () => {
  const base = { "git symbolic-ref --short": { ok: true, out: "origin/main" } };

  const withExisting = (answers: Record<string, { ok: boolean; out: string }>) => {
    const f = fake(answers);
    const r = openPullRequest({ cwd: tmp(), branch: "b", title: "t", body: "x", bodyFile: path.join(tmp(), "pr-body.md"), run: f.run, existingUrl: "https://x/pull/3" });
    return { r, calls: f.calls.map((c) => `${c.cmd} ${c.args[0]}`) };
  };
  const viewOf = (out: string) => ({ "gh pr view": { ok: true, out } });

  it("with an existing PR that is still open it only pushes, and reports that url as updated", () => {
    const { r, calls } = withExisting({ ...viewOf("OPEN\n"), "git push -u": { ok: true, out: "" } });
    expect(r).toEqual({ status: "opened", url: "https://x/pull/3", updated: true });
    expect(calls).toEqual(["gh pr", "git push"]);
  });

  it("with an existing PR that was merged or closed it pushes and creates a new one", () => {
    for (const state of ["MERGED", "CLOSED"]) {
      const { r, calls } = withExisting({
        ...viewOf(`${state}\n`),
        "git symbolic-ref --short": { ok: true, out: "origin/main" },
        "git push -u": { ok: true, out: "" },
        "gh pr create": { ok: true, out: "https://x/pull/9\n" },
      });
      expect(r, state).toEqual({ status: "opened", url: "https://x/pull/9" });
      expect(calls, state).toEqual(["gh pr", "git symbolic-ref", "git push", "gh pr"]);
    }
  });

  it("when the state lookup itself fails it keeps the push-only behaviour", () => {
    const { r, calls } = withExisting({ "gh pr view": { ok: false, out: "gh: not logged in" }, "git push -u": { ok: true, out: "" } });
    expect(r).toEqual({ status: "opened", url: "https://x/pull/3", updated: true });
    expect(calls).toEqual(["gh pr", "git push"]);
  });

  it("with an existing open PR a failed push is the normal failed result", () => {
    const { r, calls } = withExisting({ ...viewOf("OPEN"), "git push -u": { ok: false, out: "rejected\nmore" } });
    expect(r).toMatchObject({ status: "failed", step: "push", reason: "rejected" });
    expect(calls).toEqual(["gh pr", "git push"]);
  });

  it("pushes the branch, then creates the PR against the default branch, and returns its URL", () => {
    const cwd = tmp();
    const bodyFile = path.join(tmp(), "pr-body.md");
    const f = fake({
      ...base,
      "git push -u": { ok: true, out: "" },
      "gh pr create": { ok: true, out: "https://github.com/o/r/pull/7\n" },
    });
    const r = openPullRequest({ cwd, branch: "agent-lyceum/run-1/lead", title: "T", body: "B\n", bodyFile, run: f.run });
    expect(r).toEqual({ status: "opened", url: "https://github.com/o/r/pull/7" });
    expect(f.calls.map((c) => `${c.cmd} ${c.args[0]}`)).toEqual(["git symbolic-ref", "git push", "gh pr"]);
    expect(f.calls.every((c) => c.cwd === cwd)).toBe(true);
    expect(f.calls[1]!.args).toEqual(["push", "-u", "origin", "agent-lyceum/run-1/lead"]);
    expect(f.calls[2]!.args).toEqual(["pr", "create", "--head", "agent-lyceum/run-1/lead", "--base", "main", "--title", "T", "--body-file", bodyFile]);
    expect(fs.readFileSync(bodyFile, "utf8")).toBe("B\n");
  });

  it("does not call gh when the push fails, and says how to finish by hand", () => {
    const cwd = tmp();
    const bodyFile = path.join(tmp(), "pr-body.md");
    const f = fake({ ...base, "git push -u": { ok: false, out: "remote: Permission denied\nfatal: x" } });
    const r = openPullRequest({ cwd, branch: "b", title: "T", body: "B", bodyFile, run: f.run });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") return;
    expect(r.step).toBe("push");
    expect(r.reason).toBe("remote: Permission denied");
    expect(r.manual).toHaveLength(2);
    expect(r.manual[0]).toBe(`git -C '${cwd}' push -u origin 'b'`);
    expect(r.manual[1]).toBe(`gh pr create --head 'b' --base 'main' --title 'T' --body-file '${path.resolve(bodyFile)}'`);
    expect(f.calls.some((c) => c.cmd === "gh" && c.args[0] === "pr")).toBe(false);
  });

  it("reports a failed gh pr create, and a gh that prints no URL", () => {
    const cwd = tmp();
    const bodyFile = path.join(tmp(), "pr-body.md");
    const failed = openPullRequest({
      cwd, branch: "b", title: "T", body: "B", bodyFile,
      run: fake({ ...base, "git push -u": { ok: true, out: "" }, "gh pr create": { ok: false, out: "a pull request already exists" } }).run,
    });
    expect(failed).toMatchObject({ status: "failed", step: "create", reason: "a pull request already exists" });
    const silent = openPullRequest({
      cwd, branch: "b", title: "T", body: "B", bodyFile,
      run: fake({ ...base, "git push -u": { ok: true, out: "" }, "gh pr create": { ok: true, out: "done" } }).run,
    });
    expect(silent).toMatchObject({ status: "failed", step: "create" });
  });

  it("fails with step write, and neither pushes nor calls gh, when the body file cannot be written", () => {
    const cwd = tmp();
    const blocker = path.join(tmp(), "a-file");
    fs.writeFileSync(blocker, "x");
    const f = fake({ ...base, "git push -u": { ok: true, out: "" }, "gh pr create": { ok: true, out: "https://x/pull/1" } });
    const r = openPullRequest({ cwd, branch: "b", title: "T", body: "B", bodyFile: path.join(blocker, "pr-body.md"), run: f.run });
    expect(r).toMatchObject({ status: "failed", step: "write", manual: [] });
    expect(f.calls.some((c) => c.args[0] === "push" || c.args[0] === "pr")).toBe(false);
  });

  it("prints manual commands that are safe to paste into a shell", () => {
    const base2 = tmp();
    const cwd = path.join(base2, "my repo");
    fs.mkdirSync(cwd);
    const bodyFile = path.join(tmp(), "pr-body.md");
    const title = "fix $HOME and `x` and it's \"quoted\"";
    const r = openPullRequest({
      cwd, branch: "agent-lyceum/run-1/lead", title, body: "B", bodyFile,
      run: fake({ ...base, "git push -u": { ok: false, out: "nope" } }).run,
    });
    if (r.status !== "failed") throw new Error("expected failure");
    expect(r.manual).toEqual([
      `git -C '${cwd}' push -u origin 'agent-lyceum/run-1/lead'`,
      `gh pr create --head 'agent-lyceum/run-1/lead' --base 'main' --title 'fix $HOME and \`x\` and it'\\''s "quoted"' --body-file '${path.resolve(bodyFile)}'`,
    ]);
  });
});

describe("pinned push and explicit base", () => {
  /** Records every call; answers push and gh pr create, and fails anything else so a stray lookup shows. */
  const recorder = () => {
    const calls: Call[] = [];
    const run: CommandRunner = (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === "git" && args.includes("push")) return { ok: true, out: "" };
      if (cmd === "gh" && args[0] === "pr") return { ok: true, out: "https://github.com/o/r/pull/5\n" };
      return { ok: false, out: "unexpected" };
    };
    return { run, calls };
  };
  const input = (over: Partial<Parameters<typeof openPullRequest>[0]>) => ({
    cwd: tmp(), branch: "b", title: "T", body: "B", bodyFile: path.join(tmp(), "pr-body.md"), ...over,
  }) as Parameters<typeof openPullRequest>[0];

  it("uses base for --base and never asks git or gh for the default branch", () => {
    const f = recorder();
    const r = openPullRequest(input({ run: f.run, base: "develop" }));
    expect(r).toEqual({ status: "opened", url: "https://github.com/o/r/pull/5" });
    const create = f.calls.find((c) => c.cmd === "gh" && c.args[0] === "pr")!;
    expect(create.args[create.args.indexOf("--base") + 1]).toBe("develop");
    expect(f.calls.some((c) => c.args.includes("symbolic-ref") || c.args.includes("view"))).toBe(false);
  });

  it("puts pinnedGit in front of the push argv (new PR and push-only update)", () => {
    const f = recorder();
    openPullRequest(input({ run: f.run, base: "main", pinnedGit: PINNED_CONFIG }));
    const push = f.calls.find((c) => c.cmd === "git")!;
    expect(push.args).toEqual([...PINNED_CONFIG, "push", "-u", "origin", "b"]);
    expect(push.args).toContain("core.hooksPath=/dev/null");

    const g = recorder();
    const run: CommandRunner = (cmd, args, cwd) => (cmd === "gh" && args[1] === "view" ? { ok: true, out: "OPEN" } : g.run(cmd, args, cwd));
    const r = openPullRequest(input({ run, pinnedGit: PINNED_CONFIG, existingUrl: "https://x/pull/3" }));
    expect(r).toMatchObject({ status: "opened", updated: true });
    expect(g.calls.find((c) => c.cmd === "git")!.args.slice(0, PINNED_CONFIG.length)).toEqual(PINNED_CONFIG);
  });

  it("without base it still asks for the default branch, and without pinnedGit the push argv is unchanged", () => {
    const f = fake({ "git symbolic-ref --short": { ok: true, out: "origin/trunk" }, "git push -u": { ok: true, out: "" }, "gh pr create": { ok: true, out: "https://x/pull/1" } });
    openPullRequest(input({ run: f.run }));
    expect(f.calls.map((c) => `${c.cmd} ${c.args[0]}`)).toEqual(["git symbolic-ref", "git push", "gh pr"]);
    expect(f.calls[2]!.args).toContain("trunk");
  });
});

describe("opening a pull request from a run (pinned push)", () => {
  const sha = () => git(env.repo, "rev-parse", "HEAD");
  const REMOTE = "git@example.com:o/r.git";
  const mailDone = (i: WakeInput) =>
    write(path.join(outboxDir(i.project, i.agent.name), `${Math.random()}.md`), `---\nto: ${i.agent.name}\ntype: done\nsubject: bye\noutcome: completed\nopen_pr: true\n---\n\n${FULL_DONE}\n`);
  /** The team lead cannot leave a product file behind, so a member writes it and the lead reports done after that file is on the branch. */
  const memberChangeThenDone = (): ((i: WakeInput) => Promise<WakeResult>) => {
    let lead = 0;
    return async (i) => {
      if (i.agent.name !== "lead") {
        write(path.join(i.workspace!.dir, "src/web/new.txt"), "n\n");
        write(path.join(outboxDir(i.project, i.agent.name), `${Math.random()}.md`), `---\nto: lead\ntype: reply\nsubject: finished\n---\n\n${withSections("reply", "finished")}\n`);
        return OK;
      }
      if (++lead === 1) write(path.join(outboxDir(i.project, "lead"), `${Math.random()}.md`), `---\nto: fe-member\ntype: task\nsubject: job\n---\n\n${withSections("task", "job")}\n`);
      else mailDone(i);
      return OK;
    };
  };

  /** Answers `git remote get-url --push origin` with `pushUrl` (or the repo's real one), everything else like a healthy push and gh. */
  function runner(opts: { pushUrl?: string; real?: boolean } = {}) {
    const calls: Call[] = [];
    const run: CommandRunner = (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === "git" && args[0] === "remote") return opts.real ? { ok: true, out: git(cwd, ...args) } : { ok: true, out: opts.pushUrl ?? REMOTE };
      if (cmd === "git" && args.includes("push")) return { ok: true, out: "" };
      if (cmd === "git" && args[0] === "symbolic-ref") return { ok: true, out: "origin/trunk" };
      if (cmd === "gh" && args[0] === "pr") return { ok: true, out: "https://github.com/o/r/pull/9\n" };
      return { ok: false, out: `unexpected: ${cmd} ${args.join(" ")}` };
    };
    const names = () => calls.map((c) => `${c.cmd} ${c.args.includes("push") ? "push" : c.args[0]}`);
    return { run, calls, names };
  }

  const checkout = (plan: Partial<WorkspacePlan> = {}) => {
    env = makeEnv();
    envs.push(env);
    initGitRepo(env.repo);
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "build the thing", cwd: env.root, runDir });
    const full: WorkspacePlan = { mode: "worktree", leadWorktree: false, taskBranch: "agent-lyceum/run-1/lead", baseRef: "origin/main", baseSha: sha(), checkoutFrom: "main", originUrl: REMOTE, ...plan };
    return { project, runDir, task, go: (pr: CommandRunner, change = true) =>
      new RunSession({ project, plan: full, task, runDir, startCheckout: true, log: () => {}, pr, verifyTiming: { killGraceMs: 100, settleWaitMs: 100 },
        invoker: async (i) => { if (change) write(path.join(env.repo, "src/web/new.txt"), "n\n"); mailDone(i); return OK; } }).run() };
  };

  it("a checkout run pushes its task branch (no lead worktree) pinned, against the base_ref without origin/", async () => {
    const { go } = checkout();
    const r = runner();
    const s = await go(r.run);
    expect(s.pr).toEqual({ status: "opened", url: "https://github.com/o/r/pull/9" });
    expect(r.names()).toEqual(["git remote", "git push", "gh pr"]);
    const push = r.calls.find((c) => c.args.includes("push"))!;
    expect(push.args).toEqual([...PINNED_CONFIG, "push", "-u", "origin", "agent-lyceum/run-1/lead"]);
    expect(push.args).toContain("core.hooksPath=/dev/null");
    expect(push.cwd).toBe(git(env.repo, "rev-parse", "--show-toplevel"));
    const create = r.calls.find((c) => c.cmd === "gh")!;
    expect(create.args[create.args.indexOf("--base") + 1]).toBe("main");
    expect(r.calls[0]!.args).toEqual(["remote", "get-url", "--push", "origin"]);
  });

  it("does not push when the push URL differs from the recorded origin_url, and prints manual commands", async () => {
    const { go, runDir } = checkout();
    const r = runner({ pushUrl: "git@evil.example:o/r.git" });
    const s = await go(r.run);
    expect(s.pr).toMatchObject({ status: "skipped" });
    expect(r.names()).toEqual(["git remote"]);
    const notes = loadRunState(runDir).notes?.join("\n") ?? "";
    expect(notes).toContain("git -C");
    expect(notes).toContain("push -u origin");
    expect(notes).toContain("gh pr create");
  });

  it("does not push when remote.origin.url matches but the push URL differs", async () => {
    const { go } = checkout({ originUrl: "https://example.com/o/r.git" });
    git(env.repo, "remote", "add", "origin", "https://example.com/o/r.git");
    git(env.repo, "config", "remote.origin.pushurl", "https://other.example/o/r.git");
    const r = runner({ real: true });
    const s = await go(r.run);
    expect(s.pr).toMatchObject({ status: "skipped" });
    expect(r.names()).toEqual(["git remote"]);
  });

  it("does not push a checkout run whose origin_url was never recorded", async () => {
    const { go } = checkout({ originUrl: undefined });
    const r = runner();
    const s = await go(r.run);
    expect(s.pr).toMatchObject({ status: "skipped" });
    expect(r.calls.some((c) => c.args.includes("push"))).toBe(false);
  });

  it("a checkout run with no file changes is skipped without any command", async () => {
    const { go } = checkout();
    const r = runner();
    const s = await go(r.run, false);
    expect(s.pr).toMatchObject({ status: "skipped", reason: expect.stringMatching(/no file changes/) });
    expect(r.calls).toEqual([]);
  });

  it("a worktree run with a base_ref uses the same URL check and base; a mismatch does not push", async () => {
    const mk = (pushUrl: string) => {
      const c = checkout();
      const r = runner({ pushUrl });
      return { r, go: () => new RunSession({ project: c.project, plan: { mode: "worktree", leadWorktree: true, baseRef: "origin/release", baseSha: sha(), originUrl: REMOTE }, task: c.task, runDir: c.runDir, log: () => {}, pr: r.run, verifyTiming: { killGraceMs: 100, settleWaitMs: 100 },
        invoker: memberChangeThenDone() }).run() };
    };
    const ok = mk(REMOTE);
    expect((await ok.go()).pr).toMatchObject({ status: "opened" });
    expect(ok.r.names()).toEqual(["git remote", "git push", "gh pr"]);
    expect(ok.r.calls.find((c) => c.cmd === "gh")!.args).toContain("release");
    const bad = mk("git@evil.example:o/r.git");
    expect((await bad.go()).pr).toMatchObject({ status: "skipped" });
    expect(bad.r.calls.some((c) => c.args.includes("push"))).toBe(false);
  });

  it("a worktree run with no base_ref keeps the default base and does no URL check", async () => {
    env = makeEnv();
    envs.push(env);
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const r = runner();
    const s = await new RunSession({ project, plan: { mode: "worktree", leadWorktree: true }, task: prepareTask({ text: "x", cwd: env.root, runDir }), runDir, log: () => {}, pr: r.run, verifyTiming: { killGraceMs: 100, settleWaitMs: 100 },
      invoker: memberChangeThenDone() }).run();
    expect(s.pr).toMatchObject({ status: "opened" });
    expect(r.names()).toEqual(["git symbolic-ref", "git push", "gh pr"]);
    expect(r.calls.find((c) => c.cmd === "gh")!.args).toContain("trunk");
  });
});

describe("where the dispatcher pushes from", () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  afterEach(() => {
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** A repo with a linked worktree whose git dir was redirected (as an agent could) to a fake common dir with a pre-push hook. */
  function plantedRepo() {
    process.env.GIT_CONFIG_GLOBAL = path.join(tmp(), "none"); // the user's own hooksPath or hooks must not decide the outcome
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    const root = fs.realpathSync(tmp());
    const remote = path.join(root, "remote.git");
    const repo = path.join(root, "repo");
    const wt = path.join(root, "wt");
    const marker = path.join(root, "hook-ran");
    sh(root, "init", "-q", "--bare", remote);
    sh(root, "init", "-q", "-b", "main", repo);
    sh(repo, "config", "user.email", "t@t");
    sh(repo, "config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    sh(repo, "add", "a.txt");
    sh(repo, "commit", "-q", "-m", "init");
    sh(repo, "remote", "add", "origin", remote);
    sh(repo, "worktree", "add", "-q", "-b", "lead-branch", wt);
    // The planting: a copy of the common dir with a hook in it, and the worktree's commondir pointed at the copy.
    const gitDir = sh(wt, "rev-parse", "--absolute-git-dir");
    const fake = path.join(root, "fake-common");
    fs.cpSync(path.join(repo, ".git"), fake, { recursive: true });
    fs.mkdirSync(path.join(fake, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(fake, "hooks", "pre-push"), `#!/bin/sh\necho planted > '${marker}'\nexit 0\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(gitDir, "commondir"), `${fake}\n`);
    return { repo, wt, marker };
  }

  it.skipIf(process.platform === "win32")("a hook planted through the worktree's git dir runs when pushing from the worktree (control)", () => {
    const { wt, marker } = plantedRepo();
    realRunner("git", ["push", "-u", "origin", "lead-branch"], wt);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("and does not run when pushing the same branch from the main repo", () => {
    const { repo, marker } = plantedRepo();
    const r = realRunner("git", ["push", "-u", "origin", "lead-branch"], repo);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

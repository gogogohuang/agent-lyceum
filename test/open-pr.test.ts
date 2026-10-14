import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultBase, openPullRequest, PR_FOOTER, prBody, prTitle, realRunner, type CommandRunner } from "../src/open-pr.js";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "open-pr-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
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

  it("with an existing PR url it only pushes, and reports that url", () => {
    const cwd = tmp();
    const f = fake({ "git push -u": { ok: true, out: "" } });
    const r = openPullRequest({ cwd, branch: "b", title: "t", body: "x", bodyFile: path.join(tmp(), "pr-body.md"), run: f.run, existingUrl: "https://x/pull/3" });
    expect(r).toEqual({ status: "opened", url: "https://x/pull/3" });
    expect(f.calls.map((c) => `${c.cmd} ${c.args[0]}`)).toEqual(["git push"]);
  });

  it("with an existing PR url a failed push is the normal failed result", () => {
    const cwd = tmp();
    const f = fake({ "git push -u": { ok: false, out: "rejected\nmore" } });
    const r = openPullRequest({ cwd, branch: "b", title: "t", body: "x", bodyFile: path.join(tmp(), "pr-body.md"), run: f.run, existingUrl: "https://x/pull/3" });
    expect(r).toMatchObject({ status: "failed", step: "push", reason: "rejected" });
    expect(f.calls.every((c) => c.cmd !== "gh")).toBe(true);
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

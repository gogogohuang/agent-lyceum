import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeSettings } from "../src/adapters/claude.js";
import { buildCodexInvocation } from "../src/adapters/codex.js";
import { writePolicy } from "../src/policy.js";
import { agentGit, assertCheckoutResumable, checkoutLeadBranch, collectAgentChanges, commitWorkspace, dirtyPaths, discardWorkspaceEdits, finishCheckoutBranch, finishLeadBranch, PINNED_CONFIG, inspectWorkspace, integrateAgentChanges, prepareAgentWorkspace, recutLeadWorkspace, planWorkspace, isolationBlocker, resolveRemoteBase, restoreBorrowedEdits, restoreWorkspaceEdits, snapshotBase, snapshotCheckout, snapshotHead, workspaceStatusPaths, type GitRunner, type WorkspacePlan } from "../src/worktree.js";
import { RunSession } from "../src/run-session.js";
import { prepareTask } from "../src/task.js";
import { git, initGitRepo, makeConcurrent, makeEnv, write, type ClaudeSettingsView, type TestEnv } from "./helpers.js";
import { acquireProjectLock } from "../src/project-lock.js";
import { loadRunState, newRunState, saveRunState, type RunState } from "../src/run-store.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("planWorkspace", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
  const state = (over: Partial<RunState>) => ({ ...over }) as RunState;

  it("isolates a clean repo with a commit: lead in its own worktree, no reason", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    expect(isolationBlocker(env.repo)).toBeUndefined();
    expect(planWorkspace(env.project())).toEqual({ mode: "worktree", leadWorktree: true });
  });

  it("isolates a repo with uncommitted changes too (they stay out of the run)", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    write(path.join(env.repo, "src/web/a.txt"), "dirty\n");
    expect(planWorkspace(env.project())).toEqual({ mode: "worktree", leadWorktree: true });
  });

  it("falls back to shared in a repo without a commit", () => {
    env = makeEnv();
    fs.mkdirSync(env.repo, { recursive: true });
    git(env.repo, "init", "-q", "-b", "main");
    expect(planWorkspace(env.project())).toEqual({ mode: "shared", leadWorktree: false, reason: "no commit yet" });
  });

  it("falls back to shared in a folder that is not a git repository", () => {
    env = makeEnv();
    expect(planWorkspace(env.project())).toEqual({ mode: "shared", leadWorktree: false, reason: "not a git repository" });
    expect(isolationBlocker(tmp())).toBe("not a git repository");
  });

  it("keeps what an old run's state recorded, whatever the repo looks like now", () => {
    env = makeEnv(); // not a git repository now
    const p = env.project();
    expect(planWorkspace(p, state({ lead_workspace: true, workspace_mode: "worktree" }))).toEqual({ mode: "worktree", leadWorktree: true });
    expect(planWorkspace(p, state({ workspace_mode: "worktree" }))).toEqual({ mode: "worktree", leadWorktree: false });
    expect(planWorkspace(p, state({ workspace_mode: "shared" }))).toEqual({ mode: "shared", leadWorktree: false });
    expect(planWorkspace(p, state({}))).toEqual({ mode: "shared", leadWorktree: false });
  });

  describe("remote base", () => {
    const fail: GitRunner = () => ({ ok: false });
    function addOrigin(repo: string, sha: string, head = "main"): void {
      git(repo, "update-ref", `refs/remotes/origin/${head}`, sha);
      git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${head}`);
      git(repo, "remote", "add", "origin", "https://example.invalid/repo.git");
    }
    const withOrigin = (): { sha: string } => {
      env = makeEnv();
      initGitRepo(env.repo);
      const sha = git(env.repo, "rev-parse", "HEAD");
      addOrigin(env.repo, sha);
      return { sha };
    };

    it("borrows a clean checkout sitting on the remote base", () => {
      const { sha } = withOrigin();
      const plan = planWorkspace(env.project(), undefined, { fetch: fail });
      expect(plan.mode).toBe("worktree");
      expect(plan.leadWorktree).toBe(false);
      expect(plan.taskBranch).toBeUndefined();
      expect(plan.baseRef).toBe("origin/main");
      expect(plan.baseSha).toBe(sha);
      expect(plan.originUrl).toBe("https://example.invalid/repo.git");
    });

    it("uses a lead worktree when the checkout has uncommitted files", () => {
      const { sha } = withOrigin();
      write(path.join(env.repo, "src/web/a.txt"), "dirty\n");
      const plan = planWorkspace(env.project(), undefined, { fetch: fail });
      expect(plan).toMatchObject({ mode: "worktree", leadWorktree: true, baseRef: "origin/main", baseSha: sha });
    });

    it("uses a lead worktree when the local branch is ahead of the remote base", () => {
      const { sha } = withOrigin();
      write(path.join(env.repo, "src/web/b.txt"), "b\n");
      git(env.repo, "add", "-A");
      git(env.repo, "commit", "-q", "-m", "ahead");
      const plan = planWorkspace(env.project(), undefined, { fetch: fail });
      expect(plan).toMatchObject({ leadWorktree: true, baseSha: sha });
      expect(git(env.repo, "rev-parse", "HEAD")).not.toBe(sha);
    });

    it("uses a lead worktree when the checkout is already on an agent-lyceum branch", () => {
      const { sha } = withOrigin();
      git(env.repo, "checkout", "-q", "-b", "agent-lyceum/r/lead"); // same commit as origin/main, so only the branch name rules it out
      const plan = planWorkspace(env.project(), undefined, { fetch: fail });
      expect(plan).toMatchObject({ leadWorktree: true, baseSha: sha });
    });

    it("uses a lead worktree when another run holds the checkout", () => {
      const { sha } = withOrigin();
      const plan = planWorkspace(env.project(), undefined, { fetch: fail, checkoutHeldByOther: true });
      expect(plan).toMatchObject({ leadWorktree: true, baseSha: sha });
    });

    it("borrows a detached HEAD that sits on the remote base", () => {
      const { sha } = withOrigin();
      git(env.repo, "checkout", "-q", "--detach", sha);
      expect(planWorkspace(env.project(), undefined, { fetch: fail }).leadWorktree).toBe(false);
    });

    it("prefers origin/main over origin/master when origin/HEAD is missing", () => {
      env = makeEnv();
      initGitRepo(env.repo);
      const sha = git(env.repo, "rev-parse", "HEAD");
      git(env.repo, "update-ref", "refs/remotes/origin/main", sha);
      git(env.repo, "update-ref", "refs/remotes/origin/master", sha);
      git(env.repo, "remote", "add", "origin", "https://example.invalid/repo.git");
      expect(resolveRemoteBase(env.repo, fail)).toEqual({ ref: "origin/main", sha, originUrl: "https://example.invalid/repo.git" });
    });

    it("falls back to origin/master, and follows origin/HEAD to another branch", () => {
      env = makeEnv();
      initGitRepo(env.repo);
      const sha = git(env.repo, "rev-parse", "HEAD");
      git(env.repo, "update-ref", "refs/remotes/origin/master", sha);
      expect(resolveRemoteBase(env.repo, fail)?.ref).toBe("origin/master");
      git(env.repo, "update-ref", "refs/remotes/origin/develop", sha);
      git(env.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
      expect(resolveRemoteBase(env.repo, fail)?.ref).toBe("origin/develop");
    });

    it("has no origin url when the remote has no push url", () => {
      env = makeEnv();
      initGitRepo(env.repo);
      const sha = git(env.repo, "rev-parse", "HEAD");
      git(env.repo, "update-ref", "refs/remotes/origin/main", sha);
      expect(resolveRemoteBase(env.repo, fail)).toEqual({ ref: "origin/main", sha });
    });

    it("uses a lead worktree and says why when origin has neither main, master nor origin/HEAD", () => {
      env = makeEnv();
      initGitRepo(env.repo);
      const sha = git(env.repo, "rev-parse", "HEAD");
      git(env.repo, "update-ref", "refs/remotes/origin/develop", sha);
      git(env.repo, "remote", "add", "origin", "https://example.invalid/repo.git");
      const plan = planWorkspace(env.project(), undefined, { fetch: fail });
      expect(plan).toMatchObject({ mode: "worktree", leadWorktree: true });
      expect(plan.baseRef).toBeUndefined();
      expect(plan.reason).toContain("no remote base");
    });

    it("fetches without prompting, and still uses the local remote ref when the fetch fails", () => {
      const { sha } = withOrigin();
      const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
      const runner: GitRunner = (_cwd, args, e) => {
        calls.push({ args, env: e });
        return { ok: false };
      };
      const plan = planWorkspace(env.project(), undefined, { fetch: runner });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toContain("fetch");
      expect(calls[0]?.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(calls[0]?.env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
      expect(plan).toMatchObject({ leadWorktree: false, baseRef: "origin/main", baseSha: sha });
      expect(plan.fetchFailed).toBe(true); // visible to the caller, which tells the user
    });

    it("does not flag a fetch that worked, and a repo with no origin never fetches", () => {
      withOrigin();
      expect(planWorkspace(env.project(), undefined, { fetch: () => ({ ok: true }) }).fetchFailed).toBeUndefined();
      env.cleanup();
      env = makeEnv();
      initGitRepo(env.repo);
      let called = 0;
      expect(planWorkspace(env.project(), undefined, { fetch: () => (called++, { ok: false }) })).toEqual({ mode: "worktree", leadWorktree: true });
      expect(called).toBe(0);
    });

    it("flags a failed fetch together with the missing-base reason", () => {
      env = makeEnv();
      initGitRepo(env.repo);
      git(env.repo, "remote", "add", "origin", "https://example.invalid/repo.git");
      const plan = planWorkspace(env.project(), undefined, { fetch: fail });
      expect(plan).toMatchObject({ mode: "worktree", leadWorktree: true, fetchFailed: true });
      expect(plan.reason).toContain("no remote base");
    });

    describe("the ssh command of a fetch", () => {
      const saved = { ssh: process.env.GIT_SSH_COMMAND, global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
      const restore = (k: string, v: string | undefined): void => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      afterEach(() => {
        restore("GIT_SSH_COMMAND", saved.ssh);
        restore("GIT_CONFIG_GLOBAL", saved.global);
        restore("GIT_CONFIG_NOSYSTEM", saved.nosystem);
      });
      const fetchEnv = (): NodeJS.ProcessEnv => {
        let seen: NodeJS.ProcessEnv = {};
        resolveRemoteBase(env.repo, (_cwd, _args, e) => {
          seen = e;
          return { ok: false };
        });
        return seen;
      };
      const repoWithOrigin = () => {
        env = makeEnv();
        initGitRepo(env.repo);
        git(env.repo, "remote", "add", "origin", "https://example.invalid/repo.git");
        process.env.GIT_CONFIG_GLOBAL = "/dev/null";
        process.env.GIT_CONFIG_NOSYSTEM = "1";
      };

      it("keeps core.sshCommand of the repo and adds BatchMode", () => {
        repoWithOrigin();
        delete process.env.GIT_SSH_COMMAND;
        git(env.repo, "config", "core.sshCommand", "ssh -i /keys/work -F /cfg");
        const e = fetchEnv();
        expect(e.GIT_SSH_COMMAND).toBe("ssh -i /keys/work -F /cfg -o BatchMode=yes");
        expect(e.GIT_TERMINAL_PROMPT).toBe("0");
      });

      it("prefers GIT_SSH_COMMAND from the environment over core.sshCommand", () => {
        repoWithOrigin();
        process.env.GIT_SSH_COMMAND = "ssh -i /keys/env";
        git(env.repo, "config", "core.sshCommand", "ssh -i /keys/work");
        expect(fetchEnv().GIT_SSH_COMMAND).toBe("ssh -i /keys/env -o BatchMode=yes");
      });

      it("uses plain ssh when neither is set", () => {
        repoWithOrigin();
        delete process.env.GIT_SSH_COMMAND;
        expect(fetchEnv().GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
      });
    });

    it("resumes a checkout run on the branch its state recorded, not the current lead name", () => {
      env = makeEnv(); // not a git repository now
      const plan = planWorkspace(env.project(), state({ workspace_mode: "checkout", task_branch: "agent-lyceum/r/lead" } as Partial<RunState>), { fetch: () => { throw new Error("must not fetch"); } });
      expect(plan).toEqual({ mode: "worktree", leadWorktree: false, taskBranch: "agent-lyceum/r/lead" });
    });

    it("stays shared, without fetching, when the repo cannot be isolated", () => {
      env = makeEnv();
      let called = 0;
      const runner: GitRunner = () => (called++, { ok: false });
      expect(planWorkspace(env.project(), undefined, { fetch: runner }).mode).toBe("shared");
      env.cleanup();
      env = makeEnv();
      fs.mkdirSync(env.repo, { recursive: true });
      git(env.repo, "init", "-q", "-b", "main");
      expect(planWorkspace(env.project(), undefined, { fetch: runner }).reason).toBe("no commit yet");
      expect(called).toBe(0);
    });
  });
});

describe("snapshotBase", () => {
  it("captures the lead's uncommitted and new files, skips ignored ones, and leaves the repo alone", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    write(path.join(env.repo, "src/web/a.txt"), "lead edit\n");
    write(path.join(env.repo, "src/web/new.txt"), "lead new file\n");
    write(path.join(env.repo, "ignored.log"), "noise\n");
    const head = git(env.repo, "rev-parse", "HEAD");
    const status = git(env.repo, "status", "--porcelain");

    const ref = snapshotBase(env.project(), "run-1", 1);
    expect(ref).toBe("refs/agent-lyceum/run-1/base-1");
    expect(git(env.repo, "show", `${ref}:src/web/a.txt`)).toBe("lead edit");
    expect(git(env.repo, "show", `${ref}:src/web/new.txt`)).toBe("lead new file");
    expect(() => git(env.repo, "show", `${ref}:ignored.log`)).toThrow();
    expect(git(env.repo, "rev-parse", `${ref}^`)).toBe(head); // child of HEAD

    expect(git(env.repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(env.repo, "branch", "--show-current")).toBe("main");
    expect(git(env.repo, "status", "--porcelain")).toBe(status);
    expect(fs.readFileSync(path.join(env.repo, "src/web/a.txt"), "utf8")).toBe("lead edit\n");
    expect(fs.readdirSync(path.join(env.repo, ".git")).filter((f) => f.includes("snapshot"))).toEqual([]);
  });

  it("works in a repo with no commit yet", () => {
    env = makeEnv();
    fs.mkdirSync(env.repo, { recursive: true });
    git(env.repo, "init", "-q");
    write(path.join(env.repo, "x.txt"), "x\n");
    const ref = snapshotBase(env.project(), "run-1", 1);
    expect(git(env.repo, "show", `${ref}:x.txt`)).toBe("x");
  });
});

describe("prepareAgentWorkspace", () => {
  function setup() {
    env = makeEnv();
    initGitRepo(env.repo);
    write(path.join(env.repo, "src/web/a.txt"), "lead edit\n");
    return env.project();
  }

  it("gives each agent its own checkout of the snapshot under the project home, invisible to the others and the main repo", () => {
    const p = setup();
    const ref = snapshotBase(p, "run-1", 1);
    const fe = prepareAgentWorkspace(p, "run-1", "fe-member", ref);
    const qa = prepareAgentWorkspace(p, "run-1", "qa-member", ref);
    expect(fe.dir).toBe(path.join(p.paths.root, "worktrees", "run-1", "fe-member"));
    expect(fs.readFileSync(path.join(fe.dir, "src/web/a.txt"), "utf8")).toBe("lead edit\n");
    expect(fe.branch).toBe("agent-lyceum/run-1/fe-member");
    expect(fs.existsSync(fe.gitDir)).toBe(true);

    write(path.join(fe.dir, "src/web/fe-only.txt"), "fe\n");
    expect(fs.existsSync(path.join(qa.dir, "src/web/fe-only.txt"))).toBe(false);
    expect(fs.existsSync(path.join(env.repo, "src/web/fe-only.txt"))).toBe(false);
    expect(git(env.repo, "branch", "--show-current")).toBe("main");
  });

  it("reuses an existing workspace for the same snapshot, edits and all (resume)", () => {
    const p = setup();
    const ref = snapshotBase(p, "run-1", 1);
    const first = prepareAgentWorkspace(p, "run-1", "fe-member", ref);
    write(path.join(first.dir, "src/web/half.txt"), "half done\n");
    const again = prepareAgentWorkspace(p, "run-1", "fe-member", ref);
    expect(again.dir).toBe(first.dir);
    expect(fs.readFileSync(path.join(again.dir, "src/web/half.txt"), "utf8")).toBe("half done\n");
  });

  it("moves a clean workspace to a newer snapshot, but never throws away unfinished work", () => {
    const p = setup();
    const r1 = snapshotBase(p, "run-1", 1);
    const ws = prepareAgentWorkspace(p, "run-1", "fe-member", r1);
    write(path.join(env.repo, "src/web/later.txt"), "later\n");
    const r2 = snapshotBase(p, "run-1", 2);

    const moved = prepareAgentWorkspace(p, "run-1", "fe-member", r2);
    expect(fs.readFileSync(path.join(moved.dir, "src/web/later.txt"), "utf8")).toBe("later\n");

    write(path.join(ws.dir, "src/web/unfinished.txt"), "keep me\n");
    write(path.join(env.repo, "src/web/even-later.txt"), "x\n");
    const r3 = snapshotBase(p, "run-1", 3);
    const kept = prepareAgentWorkspace(p, "run-1", "fe-member", r3);
    expect(fs.readFileSync(path.join(kept.dir, "src/web/unfinished.txt"), "utf8")).toBe("keep me\n");
    expect(kept.base).toBe(moved.base); // still based on the snapshot its edits started from
  });

  it("works when the project dir is a subfolder of the repo", () => {
    env = makeEnv();
    initGitRepo(env.repo, { "app/src/x.txt": "x\n", "other/y.txt": "y\n" });
    env.editProjectYaml((t) => t.replace(/^dir: .*$/m, `dir: ${path.join(env.repo, "app")}`));
    const p = env.project();
    const ws = prepareAgentWorkspace(p, "run-1", "fe-member", snapshotBase(p, "run-1", 1));
    expect(ws.dir).toBe(path.join(ws.root, "app"));
    expect(fs.readFileSync(path.join(ws.dir, "src/x.txt"), "utf8")).toBe("x\n");
  });
});

describe("dirtyPaths", () => {
  it("lists modified, staged and untracked files, and nothing for a clean repo", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    expect(dirtyPaths(env.repo)).toEqual([]);
    write(path.join(env.repo, "src/web/a.txt"), "changed\n");
    write(path.join(env.repo, "new.txt"), "n\n");
    write(path.join(env.repo, "ignored.log"), "n\n");
    expect(dirtyPaths(env.repo).sort()).toEqual(["new.txt", "src/web/a.txt"]);
  });
});

describe("adapters in a worktree", () => {
  it("point Claude Code and Codex at the agent's checkout, not the main repo", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const base = env.project();
    const ws = prepareAgentWorkspace(base, "run-1", "fe-member", snapshotBase(base, "run-1", 1));
    const p = { ...base, workspaces: { "fe-member": ws } };
    const s = buildClaudeSettings(p, p.agents["fe-member"]) as unknown as ClaudeSettingsView;
    expect(s.permissions.allow).toContain(`Edit(/${ws.dir}/**)`);
    expect(s.permissions.allow).not.toContain(`Edit(/${env.repo}/**)`);
    expect(s.sandbox.filesystem.allowWrite).toContain(ws.root);
    expect(s.sandbox.filesystem.allowWrite).toContain(ws.gitDir);
    expect(s.sandbox.filesystem.allowWrite).not.toContain(env.repo);

    const codex = buildCodexInvocation({ project: p, agent: p.agents["fe-member"], workDir: path.join(env.root, "w"), systemPrompt: "S", userPrompt: "U", timeoutSec: 5 });
    expect(codex.cwd).toBe(ws.dir);
    expect(codex.args[codex.args.indexOf("-C") + 1]).toBe(ws.dir);
    expect(codex.args.join(" ")).toContain(ws.gitDir);

    const other = prepareAgentWorkspace(base, "run-1", "qa-member", snapshotBase(base, "run-1", 2));
    const pol = writePolicy({ ...p, workspaces: { "fe-member": ws, "qa-member": other } }, p.agents["fe-member"]);
    expect(pol.deny).toContain(other.root); // another agent's checkout is off limits
    expect(pol.deny).not.toContain(ws.root);
    expect(pol.deny).toContain(path.join(ws.dir, "CLAUDE.md")); // its own copy of the protected files too
  });
});

describe("concurrent runs: base and lead workspace", () => {
  function concurrentRepo() {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    return env.project();
  }

  it("starts from HEAD even when the working tree has uncommitted changes, and leaves the working tree alone", () => {
    const p = concurrentRepo();
    write(path.join(env.repo, "src/web/a.txt"), "uncommitted edit\n");
    expect(isolationBlocker(p.dir)).toBeUndefined();
    const ref = snapshotHead(p, "run-1");
    expect(ref).toBe("refs/agent-lyceum/run-1/base-0");
    expect(git(env.repo, "rev-parse", ref)).toBe(git(env.repo, "rev-parse", "HEAD"));
    const ws = prepareAgentWorkspace(p, "run-1", "lead", ref);
    expect(fs.readFileSync(path.join(ws.dir, "src/web/a.txt"), "utf8")).toBe("a\n"); // the edit is not part of the run
    expect(fs.readFileSync(path.join(env.repo, "src/web/a.txt"), "utf8")).toBe("uncommitted edit\n");
    expect(ws.branch).toBe("agent-lyceum/run-1/lead");
  });

  it("reports a repository without any commit as not isolatable", () => {
    env = makeEnv();
    git(env.repo, "init", "-q", "-b", "main");
    expect(isolationBlocker(env.repo)).toBe("no commit yet");
  });

  it("snapshots the lead's worktree for members and brings a member's files into the lead's worktree, not the repo", () => {
    const p = concurrentRepo();
    const lead = prepareAgentWorkspace(p, "run-1", "lead", snapshotHead(p, "run-1"));
    write(path.join(lead.dir, "src/web/lead-note.txt"), "lead was here\n");
    const ref = snapshotBase(p, "run-1", 1, lead);
    const member = prepareAgentWorkspace(p, "run-1", "fe-member", ref);
    expect(fs.readFileSync(path.join(member.dir, "src/web/lead-note.txt"), "utf8")).toBe("lead was here\n");
    write(path.join(member.dir, "src/web/feature.txt"), "built\n");
    const r = integrateAgentChanges(p, collectAgentChanges(member, ["src/web/**"]), lead);
    expect(r.status).toBe("integrated");
    expect(fs.readFileSync(path.join(lead.dir, "src/web/feature.txt"), "utf8")).toBe("built\n");
    expect(fs.existsSync(path.join(env.repo, "src/web/feature.txt"))).toBe(false);
    expect(git(env.repo, "status", "--porcelain")).toBe("");
  });

  it("commits the lead's work on its branch and writes a patch; a run with no changes commits nothing", () => {
    const p = concurrentRepo();
    const lead = prepareAgentWorkspace(p, "run-1", "lead", snapshotHead(p, "run-1"));
    const none = finishLeadBranch(lead, "msg", path.join(env.root, "none.patch"));
    expect(none).toMatchObject({ files: 0, head: lead.base });
    expect(none.patch).toBeUndefined();

    write(path.join(lead.dir, "src/web/new.txt"), "new\n");
    const rb = finishLeadBranch(lead, "agent-lyceum: lead's work for run run-1", path.join(env.root, "lead.patch"));
    expect(rb.files).toBe(1);
    expect(rb.branch).toBe("agent-lyceum/run-1/lead");
    expect(git(env.repo, "log", "-1", "--format=%s", rb.branch)).toBe("agent-lyceum: lead's work for run run-1");
    expect(fs.readFileSync(rb.patch!, "utf8")).toContain("src/web/new.txt");
    expect(commitWorkspace(lead, "again")).toMatchObject({ committed: false, head: rb.head });
    expect(git(env.repo, "status", "--porcelain")).toBe("");
    // merging the branch brings the work in
    git(env.repo, "merge", "-q", "--no-edit", rb.branch);
    expect(fs.readFileSync(path.join(env.repo, "src/web/new.txt"), "utf8")).toBe("new\n");
  });

  it("inspectWorkspace compares a member with the lead's worktree, and the lead with the repo", () => {
    const p = concurrentRepo();
    const lead = prepareAgentWorkspace(p, "run-1", "lead", snapshotHead(p, "run-1"));
    const ref = snapshotBase(p, "run-1", 1, lead);
    const member = prepareAgentWorkspace(p, "run-1", "fe-member", ref);
    write(path.join(member.dir, "src/web/feature.txt"), "built\n");
    integrateAgentChanges(p, collectAgentChanges(member, ["src/web/**"]), lead);
    // the member's file is in the lead's worktree, so the member holds nothing that exists nowhere else
    expect(inspectWorkspace(p, "run-1", "fe-member", lead)?.unintegrated).toEqual([]);
    // the lead's worktree holds it, and the repo does not have it yet
    expect(inspectWorkspace(p, "run-1", "lead")?.dirty).toContain("src/web/feature.txt");
    finishLeadBranch(lead, "m", path.join(env.root, "p.patch"));
    expect(inspectWorkspace(p, "run-1", "lead")?.unintegrated).toContain("src/web/feature.txt");
    git(env.repo, "merge", "-q", "--no-edit", lead.branch);
    expect(inspectWorkspace(p, "run-1", "lead")?.unintegrated).toEqual([]);
  });
  describe("recutLeadWorkspace", () => {
    const setup = () => {
      const p = concurrentRepo();
      const lead = prepareAgentWorkspace(p, "run-1", "lead", snapshotHead(p, "run-1"));
      write(path.join(lead.dir, "src/web/first.txt"), "first\n");
      const rb = finishLeadBranch(lead, "m", path.join(env.root, "p.patch"));
      return { p, lead, rb };
    };

    it("cuts a fresh branch from HEAD once the old one was merged, and the old work is no change of the new branch", () => {
      const { p, lead, rb } = setup();
      git(env.repo, "merge", "-q", "--no-edit", rb.branch);
      write(path.join(env.repo, "src/web/other.txt"), "o\n");
      git(env.repo, "add", "-A");
      git(env.repo, "commit", "-q", "-m", "more");
      const headBefore = git(env.repo, "rev-parse", "HEAD");
      const r = recutLeadWorkspace(p, "run-1", "lead", lead, rb.head);
      expect(r.recut).toBe(true);
      expect(r.ws.branch).toBe(lead.branch);
      expect(r.ws.base).toBe(headBefore);
      expect(git(r.ws.root, "rev-parse", "HEAD")).toBe(headBefore);
      expect(git(env.repo, "rev-parse", r.ws.branch)).toBe(headBefore);
      write(path.join(r.ws.dir, "src/web/second.txt"), "second\n");
      const rb2 = finishLeadBranch(r.ws, "m2", path.join(env.root, "p2.patch"));
      expect(rb2.files).toBe(1);
      expect(git(env.repo, "diff", "--name-only", rb2.base, rb2.head)).toBe("src/web/second.txt");
      expect(git(env.repo, "rev-parse", "HEAD")).toBe(headBefore); // your HEAD is untouched
    });

    it("keeps the worktree and branch when the branch is not merged, or when there is no stored head", () => {
      const { p, lead, rb } = setup();
      expect(recutLeadWorkspace(p, "run-1", "lead", lead, rb.head)).toEqual({ ws: lead, recut: false });
      git(env.repo, "merge", "-q", "--no-edit", rb.branch);
      expect(recutLeadWorkspace(p, "run-1", "lead", lead, undefined)).toEqual({ ws: lead, recut: false });
      expect(git(env.repo, "rev-parse", lead.branch)).toBe(rb.head);
    });

    it("never recuts a worktree with uncommitted changes or whose state is unknown, even when the branch is merged", () => {
      const { p, lead, rb } = setup();
      git(env.repo, "merge", "-q", "--no-edit", rb.branch);
      write(path.join(lead.dir, "src/web/wip.txt"), "wip\n");
      expect(recutLeadWorkspace(p, "run-1", "lead", lead, rb.head).recut).toBe(false);
      expect(fs.existsSync(path.join(lead.dir, "src/web/wip.txt"))).toBe(true);
      fs.rmSync(path.join(lead.dir, "src/web/wip.txt"));
      fs.rmSync(`${lead.root}.json`); // metadata gone: what the worktree holds cannot be told
      expect(recutLeadWorkspace(p, "run-1", "lead", lead, rb.head).recut).toBe(false);
      expect(fs.existsSync(lead.root)).toBe(true);
    });

    it("recuts from the user's local HEAD, which holds work the run's base_sha does not", () => {
      const { p, lead, rb } = setup();
      const baseSha = git(env.repo, "rev-parse", "HEAD"); // what a remote base would have recorded
      git(env.repo, "merge", "-q", "--no-edit", rb.branch);
      write(path.join(env.repo, "src/web/local.txt"), "l\n");
      git(env.repo, "add", "-A");
      git(env.repo, "commit", "-q", "-m", "local");
      const head = git(env.repo, "rev-parse", "HEAD");
      const r = recutLeadWorkspace(p, "run-1", "lead", lead, rb.head);
      expect(r.recut).toBe(true);
      expect(r.ws.base).toBe(head);
      expect(r.ws.base).not.toBe(baseSha);
      expect(fs.existsSync(path.join(r.ws.dir, "src/web/first.txt"))).toBe(true); // the merged work is not dropped
      expect(fs.existsSync(path.join(r.ws.dir, "src/web/local.txt"))).toBe(true);
    });

    it("does not recut while HEAD is on another task's agent-lyceum branch, even when the old branch is merged into it", () => {
      const { p, lead, rb } = setup();
      git(env.repo, "merge", "-q", "--no-edit", rb.branch);
      git(env.repo, "checkout", "-q", "-b", "agent-lyceum/other/lead"); // clean, and rb.head is still its ancestor
      expect(git(env.repo, "merge-base", "--is-ancestor", rb.head, "HEAD")).toBe("");
      expect(recutLeadWorkspace(p, "run-1", "lead", lead, rb.head)).toEqual({ ws: lead, recut: false });
      expect(fs.existsSync(lead.root)).toBe(true);
      expect(git(env.repo, "rev-parse", lead.branch)).toBe(rb.head);
    });
  });
});

describe("a worktree run with a remote base", () => {
  const SHA_PLAN = (baseSha: string): WorkspacePlan => ({ mode: "worktree", leadWorktree: true, baseRef: "origin/main", baseSha, originUrl: "https://example.invalid/repo.git" });
  const start = (plan: WorkspacePlan) => {
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "build it", cwd: env.root, runDir });
    const said: string[] = [];
    const session = new RunSession({ project, plan, task, runDir, log: (s: string) => said.push(s), invoker: async () => ({ ok: true, text: "", exitCode: 0, timedOut: false }) });
    return { runDir, said, session, out: () => said.join("\n") };
  };
  /** A repo whose local HEAD is one commit past `baseSha` (the commit the remote base had). */
  const aheadRepo = () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    const baseSha = git(env.repo, "rev-parse", "HEAD");
    write(path.join(env.repo, "src/web/local.txt"), "l\n");
    git(env.repo, "add", "-A");
    git(env.repo, "commit", "-q", "-m", "local");
    return { baseSha, head: git(env.repo, "rev-parse", "HEAD") };
  };

  it("cuts the lead worktree from baseSha, not from the local HEAD, and records the remote base in the state", () => {
    const { baseSha, head } = aheadRepo();
    const { runDir, session } = start(SHA_PLAN(baseSha));
    expect(head).not.toBe(baseSha);
    expect(git(env.repo, "rev-parse", "refs/agent-lyceum/run-1/base-0")).toBe(baseSha);
    const ws = (session as unknown as { leadSpace: { base: string; root: string } }).leadSpace;
    expect(ws.base).toBe(baseSha);
    expect(git(ws.root, "rev-parse", "HEAD")).toBe(baseSha);
    expect(fs.existsSync(path.join(ws.root, "src/web/local.txt"))).toBe(false);
    const s = loadRunState(runDir);
    expect(s).toMatchObject({ workspace_mode: "worktree", lead_workspace: true, base_ref: "origin/main", base_sha: baseSha, origin_url: "https://example.invalid/repo.git" });
    expect(s.task_branch).toBeUndefined();
    expect(s.schema_version).toBe(2);
  });

  it("says the work is not in your local checkout yet when HEAD is not on an agent-lyceum branch", () => {
    const { baseSha } = aheadRepo();
    const { out } = start(SHA_PLAN(baseSha));
    expect(out()).toContain("本地尚未進入這顆 commit");
    expect(out()).not.toContain("這次 run 改在 worktree");
  });

  it("says this run works in a worktree when HEAD is on an agent-lyceum branch", () => {
    const { baseSha } = aheadRepo();
    git(env.repo, "checkout", "-q", "-b", "agent-lyceum/other/lead");
    const { out } = start(SHA_PLAN(baseSha));
    expect(out()).toContain("這次 run 改在 worktree");
    expect(out()).not.toContain("本地尚未進入這顆 commit");
  });

  it("without a baseSha still starts from the local HEAD, records no remote base, and prints neither note", () => {
    const { head } = aheadRepo();
    const { runDir, out } = start({ mode: "worktree", leadWorktree: true });
    expect(git(env.repo, "rev-parse", "refs/agent-lyceum/run-1/base-0")).toBe(head);
    expect(loadRunState(runDir).base_sha).toBeUndefined();
    expect(out()).not.toMatch(/這次 run 改在 worktree|本地尚未進入這顆 commit/);
  });

  it("prints no note when HEAD already is baseSha", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    const { out } = start(SHA_PLAN(git(env.repo, "rev-parse", "HEAD")));
    expect(out()).not.toMatch(/這次 run 改在 worktree|本地尚未進入這顆 commit/);
  });
});

describe("checkoutLeadBranch", () => {
  const BRANCH = "agent-lyceum/run-1/lead";
  const hook = (name: string, body: string) => {
    const f = path.join(env.repo, ".git", "hooks", name);
    write(f, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(f, 0o755);
  };
  const clean = (): string => {
    env = makeEnv();
    initGitRepo(env.repo);
    return git(env.repo, "rev-parse", "HEAD");
  };

  it("cuts the task branch from sha: HEAD is on it at sha, main is untouched", () => {
    const sha = clean();
    expect(checkoutLeadBranch(env.repo, BRANCH, sha)).toEqual({ moved: true });
    expect(git(env.repo, "branch", "--show-current")).toBe(BRANCH);
    expect(git(env.repo, "rev-parse", "HEAD")).toBe(sha);
    expect(git(env.repo, "rev-parse", "main")).toBe(sha);
  });

  it("throws when the branch already exists, and HEAD stays where it was (never -B)", () => {
    const sha = clean();
    write(path.join(env.repo, "more.txt"), "more\n");
    git(env.repo, "add", "-A");
    git(env.repo, "commit", "-q", "-m", "second");
    git(env.repo, "branch", BRANCH, sha);
    const head = git(env.repo, "rev-parse", "HEAD");
    expect(() => checkoutLeadBranch(env.repo, BRANCH, sha)).toThrow(BRANCH);
    expect(git(env.repo, "branch", "--show-current")).toBe("main");
    expect(git(env.repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(env.repo, "rev-parse", BRANCH)).toBe(sha); // the existing branch was not reset
  });

  it("a failing post-checkout hook does not matter once HEAD is on the new branch", () => {
    const sha = clean();
    hook("post-checkout", "exit 1");
    expect(checkoutLeadBranch(env.repo, BRANCH, sha)).toEqual({ moved: true });
    expect(git(env.repo, "branch", "--show-current")).toBe(BRANCH);
  });

  it("a hook that stops the switch leaves HEAD where it was: moved is false", () => {
    const sha = clean();
    hook("reference-transaction", '[ "$1" = prepared ] && exit 1\nexit 0');
    expect(checkoutLeadBranch(env.repo, BRANCH, sha)).toEqual({ moved: false });
    expect(git(env.repo, "branch", "--show-current")).toBe("main");
  });

  it("runs the repository's hooks (they are not switched off)", () => {
    const sha = clean();
    hook("post-checkout", `echo ran > "${path.join(env.root, "hook-ran")}"`);
    checkoutLeadBranch(env.repo, BRANCH, sha);
    expect(fs.existsSync(path.join(env.root, "hook-ran"))).toBe(true);
  });
});

describe("an aborted checkout start", () => {
  const BRANCH = "agent-lyceum/run-1/lead";

  /** A repo on `main`, and the run dir of a run that wrote its state (no task_sent) and was about to cut its branch. */
  function setup(over: Partial<RunState> = {}) {
    env = makeEnv();
    initGitRepo(env.repo);
    const sha = git(env.repo, "rev-parse", "HEAD");
    const runDir = path.join(env.root, "runs", "run-1");
    write(path.join(runDir, "task.md"), "the task\n");
    const state = newRunState({ run_id: "run-1", workspace_mode: "checkout", task_branch: BRANCH, base_ref: "origin/main", base_sha: sha, checkout_from: "main", ...over });
    state.schema_version = 4;
    saveRunState(runDir, state);
    return { sha, runDir, state: loadRunState(runDir) };
  }
  const onBranch = (sha: string) => {
    git(env.repo, "checkout", "-q", "-b", BRANCH, sha);
  };
  const gone = (runDir: string) => expect(fs.existsSync(runDir)).toBe(false);

  it("the branch was never cut: the whole run dir (task.md too) goes, HEAD stays", () => {
    const { runDir, state } = setup();
    expect(() => assertCheckoutResumable(env.repo, runDir, state)).toThrow(/never/);
    gone(runDir);
    expect(git(env.repo, "branch", "--show-current")).toBe("main");
  });

  it("is only done by the process that holds the run lock: while the starter holds it, the second call is refused and nothing is deleted", () => {
    const { runDir, state } = setup();
    const root = env.project().paths.root;
    const starter = acquireProjectLock(root, "run-1", { checkout: true, dir: env.repo });
    expect(() => acquireProjectLock(root, "run-1", { checkout: true, dir: env.repo })).toThrow(/still running/);
    expect(fs.existsSync(path.join(runDir, "task.md"))).toBe(true);
    starter.release();
    const lease = acquireProjectLock(root, "run-1", { checkout: true, dir: env.repo });
    try {
      expect(() => assertCheckoutResumable(env.repo, runDir, state)).toThrow(/never/);
    } finally {
      lease.release();
    }
    gone(runDir);
  });

  it("HEAD is on the task branch at base_sha with a clean tree: back to checkout_from, the branch and the run dir are removed", () => {
    const { sha, runDir, state } = setup();
    onBranch(sha);
    expect(() => assertCheckoutResumable(env.repo, runDir, state)).toThrow(/never/);
    expect(git(env.repo, "branch", "--show-current")).toBe("main");
    expect(git(env.repo, "branch", "--list", BRANCH)).toBe("");
    gone(runDir);
  });

  it("the branch exists at base_sha but HEAD is elsewhere: only the branch and the run dir go", () => {
    const { sha, runDir, state } = setup();
    git(env.repo, "branch", BRANCH, sha);
    expect(() => assertCheckoutResumable(env.repo, runDir, state)).toThrow(/never/);
    expect(git(env.repo, "branch", "--show-current")).toBe("main");
    expect(git(env.repo, "branch", "--list", BRANCH)).toBe("");
    gone(runDir);
  });

  it("checkout_from was deleted: no second switch; state and HEAD stay and the error names both branches", () => {
    const { sha, runDir, state } = setup();
    onBranch(sha);
    git(env.repo, "branch", "-D", "main");
    expect(() => assertCheckoutResumable(env.repo, runDir, state)).toThrow(new RegExp(`${BRANCH}[\\s\\S]*main|main[\\s\\S]*${BRANCH}`));
    expect(git(env.repo, "branch", "--show-current")).toBe(BRANCH);
    expect(fs.existsSync(path.join(runDir, "state.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "task.md"))).toBe(true);
  });

  it("an origin/<checkout_from> that still exists does not bring a deleted local branch back", () => {
    const { sha, runDir, state } = setup();
    onBranch(sha);
    git(env.repo, "update-ref", "refs/remotes/origin/main", sha);
    git(env.repo, "branch", "-D", "main");
    expect(() => assertCheckoutResumable(env.repo, runDir, state)).toThrow();
    expect(git(env.repo, "branch", "--list", "main")).toBe("");
    expect(git(env.repo, "branch", "--show-current")).toBe(BRANCH);
  });

  it("the task branch has its own commits: refused, nothing deleted", () => {
    const { sha, runDir, state } = setup();
    onBranch(sha);
    write(path.join(env.repo, "mine.txt"), "mine\n");
    git(env.repo, "add", "-A");
    git(env.repo, "commit", "-q", "-m", "mine");
    const tip = git(env.repo, "rev-parse", "HEAD");
    expect(() => assertCheckoutResumable(env.repo, runDir, state)).toThrow(BRANCH);
    expect(git(env.repo, "branch", "--show-current")).toBe(BRANCH);
    expect(git(env.repo, "rev-parse", BRANCH)).toBe(tip);
    expect(fs.existsSync(path.join(runDir, "state.json"))).toBe(true);
  });

  it("own commits on the branch while HEAD is elsewhere: refused, the branch is kept", () => {
    const { sha, runDir, state } = setup();
    onBranch(sha);
    write(path.join(env.repo, "mine.txt"), "mine\n");
    git(env.repo, "add", "-A");
    git(env.repo, "commit", "-q", "-m", "mine");
    git(env.repo, "checkout", "-q", "main");
    expect(() => assertCheckoutResumable(env.repo, runDir, state)).toThrow(BRANCH);
    expect(git(env.repo, "branch", "--list", BRANCH)).not.toBe("");
    expect(fs.existsSync(path.join(runDir, "state.json"))).toBe(true);
  });

  it("an uncommitted change on the task branch: refused, HEAD stays and nothing is deleted", () => {
    const { sha, runDir, state } = setup();
    onBranch(sha);
    write(path.join(env.repo, "src/web/a.txt"), "edited\n");
    expect(() => assertCheckoutResumable(env.repo, runDir, state)).toThrow(/uncommitted/);
    expect(git(env.repo, "branch", "--show-current")).toBe(BRANCH);
    expect(fs.existsSync(path.join(runDir, "state.json"))).toBe(true);
  });

  it("task_sent with HEAD on the task branch: the run may continue", () => {
    const { sha, runDir, state } = setup({ task_sent: true });
    onBranch(sha);
    expect(() => assertCheckoutResumable(env.repo, runDir, state)).not.toThrow();
    expect(fs.existsSync(path.join(runDir, "state.json"))).toBe(true);
  });

  it("task_sent but HEAD is not on the task branch: refused with the branch name; no switch, nothing deleted", () => {
    const { sha, runDir, state } = setup({ task_sent: true });
    git(env.repo, "branch", BRANCH, sha);
    expect(() => assertCheckoutResumable(env.repo, runDir, state)).toThrow(BRANCH);
    expect(git(env.repo, "branch", "--show-current")).toBe("main");
    expect(fs.existsSync(path.join(runDir, "state.json"))).toBe(true);
  });
});

describe("finishCheckoutBranch", () => {
  const BRANCH = "agent-lyceum/run-1/lead";
  const setup = () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const sha = git(env.repo, "rev-parse", "HEAD");
    git(env.repo, "checkout", "-q", "-b", BRANCH, sha);
    return { sha, patch: path.join(env.root, "lead.patch") };
  };
  /** A runner that runs real git and records every argument list. */
  const recording = () => {
    const calls: string[][] = [];
    const run: GitRunner = (cwd, args, extra) => {
      calls.push(args);
      const r = spawnSync("git", args, { cwd, env: { ...process.env, ...extra }, encoding: "utf8" });
      return r.status === 0 ? { ok: true, stdout: r.stdout.replace(/\n$/, "") } : { ok: false };
    };
    return { run, calls };
  };

  it("HEAD on the task branch with an uncommitted file: one commit on the branch, main is unchanged, the patch holds the file", () => {
    const { sha, patch } = setup();
    write(path.join(env.repo, "src/web/new.txt"), "new\n");
    const rb = finishCheckoutBranch(env.repo, BRANCH, sha, "agent-lyceum: lead's work", patch);
    expect(rb).toMatchObject({ branch: BRANCH, base: sha, files: 1, patch });
    expect(git(env.repo, "rev-parse", "main")).toBe(sha);
    expect(git(env.repo, "rev-list", "--count", `${sha}..${BRANCH}`)).toBe("1");
    expect(git(env.repo, "rev-parse", BRANCH)).toBe(rb?.head);
    expect(git(env.repo, "log", "-1", "--format=%s", BRANCH)).toBe("agent-lyceum: lead's work");
    expect(fs.readFileSync(patch, "utf8")).toContain("src/web/new.txt");
    expect(git(env.repo, "status", "--porcelain")).toBe("");
  });

  it("nothing changed: no new commit, files is 0 and there is no patch", () => {
    const { sha, patch } = setup();
    const rb = finishCheckoutBranch(env.repo, BRANCH, sha, "m", patch);
    expect(rb).toEqual({ branch: BRANCH, head: sha, base: sha, files: 0, patch: undefined });
    expect(git(env.repo, "rev-parse", BRANCH)).toBe(sha);
    expect(fs.existsSync(patch)).toBe(false);
  });

  it("HEAD moved to main: undefined, nothing is committed, main has no new commit", () => {
    const { sha, patch } = setup();
    git(env.repo, "checkout", "-q", "main");
    write(path.join(env.repo, "src/web/new.txt"), "new\n");
    expect(finishCheckoutBranch(env.repo, BRANCH, sha, "m", patch)).toBeUndefined();
    expect(git(env.repo, "rev-parse", "main")).toBe(sha);
    expect(git(env.repo, "rev-list", "--count", "main")).toBe("1");
    expect(git(env.repo, "status", "--porcelain")).toContain("new.txt"); // left as it was, not staged
    expect(fs.existsSync(patch)).toBe(false);
  });

  it("a detached HEAD at the task branch's commit is not the branch either", () => {
    const { sha, patch } = setup();
    git(env.repo, "checkout", "-q", "--detach", sha);
    write(path.join(env.repo, "src/web/new.txt"), "new\n");
    expect(finishCheckoutBranch(env.repo, BRANCH, sha, "m", patch)).toBeUndefined();
    expect(git(env.repo, "rev-list", "--count", "--all")).toBe("1");
  });

  it("git runs with the pinned config: hooks off and signing off, on the add and the commit", () => {
    const { sha, patch } = setup();
    write(path.join(env.repo, "src/web/new.txt"), "new\n");
    const { run, calls } = recording();
    finishCheckoutBranch(env.repo, BRANCH, sha, "m", patch, run);
    const commit = calls.find((a) => a.includes("commit"));
    const add = calls.find((a) => a.includes("add"));
    expect(commit).toBeDefined();
    for (const args of [commit, add]) {
      expect(args).toEqual(expect.arrayContaining(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.fsmonitor=false"]));
      expect(args!.slice(0, PINNED_CONFIG.length)).toEqual(PINNED_CONFIG);
    }
    expect(commit).toContain("--no-verify");
  });

  it("a planted post-commit hook does not run", () => {
    const { sha, patch } = setup();
    const hook = path.join(env.repo, ".git", "hooks", "post-commit");
    write(hook, `#!/bin/sh\necho ran > "${path.join(env.root, "hook-ran")}"\n`);
    fs.chmodSync(hook, 0o755);
    write(path.join(env.repo, "src/web/new.txt"), "new\n");
    finishCheckoutBranch(env.repo, BRANCH, sha, "m", patch);
    expect(fs.existsSync(path.join(env.root, "hook-ran"))).toBe(false);
  });

  it("a nested git repository in the checkout is refused before anything is staged", () => {
    const { sha, patch } = setup();
    git(env.repo, "init", "-q", path.join(env.repo, "nested"));
    write(path.join(env.repo, "nested", "f.txt"), "f\n");
    expect(() => finishCheckoutBranch(env.repo, BRANCH, sha, "m", patch)).toThrow(/nested git repository at nested/);
    expect(git(env.repo, "rev-parse", BRANCH)).toBe(sha);
    expect(git(env.repo, "diff", "--cached", "--name-only")).toBe("");
  });
});

describe("discardWorkspaceEdits", () => {
  it("returns the worktree to the recorded commit and drops later commits and untracked files", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const p = env.project();
    const ref = snapshotBase(p, "run-1", 1);
    const ws = prepareAgentWorkspace(p, "run-1", "fe-member", ref);
    write(path.join(ws.dir, "kept.txt"), "kept\n");
    commitWorkspace(ws, "kept");
    const head = agentGit(ws, ["rev-parse", "HEAD"]);
    write(path.join(ws.dir, "during.txt"), "during\n");
    commitWorkspace(ws, "during");
    write(path.join(ws.dir, "untracked.txt"), "loose\n");
    discardWorkspaceEdits(ws, head);
    expect(agentGit(ws, ["rev-parse", "HEAD"])).toBe(head);
    expect(fs.existsSync(path.join(ws.dir, "during.txt"))).toBe(false);
    expect(fs.existsSync(path.join(ws.dir, "untracked.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(ws.dir, "kept.txt"), "utf8")).toBe("kept\n");
  });
});

describe("restoreBorrowedEdits", () => {
  it("puts back only paths a read-only wake changed, and leaves paths that were already dirty", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    write(path.join(env.repo, "already.txt"), "user\n");
    const snap = snapshotCheckout(env.repo);
    expect(snap).toBeDefined();
    write(path.join(env.repo, "during.txt"), "agent\n");
    write(path.join(env.repo, "tracked.txt"), "new\n");
    git(env.repo, "add", "tracked.txt");
    git(env.repo, "commit", "-m", "agent");
    restoreBorrowedEdits(env.repo, snap!);
    expect(fs.existsSync(path.join(env.repo, "during.txt"))).toBe(false);
    expect(fs.existsSync(path.join(env.repo, "tracked.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(env.repo, "already.txt"), "utf8")).toBe("user\n");
  });
});

describe("restoreWorkspaceEdits", () => {
  it("puts back only paths the wake changed, and leaves a file that was already untracked", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const p = env.project();
    const ref = snapshotBase(p, "run-1", 1);
    const ws = prepareAgentWorkspace(p, "run-1", "fe-member", ref);
    write(path.join(ws.dir, "already.txt"), "user\n");
    const snap = { head: agentGit(ws, ["rev-parse", "HEAD"]), dirty: workspaceStatusPaths(ws) };
    write(path.join(ws.dir, "during.txt"), "agent\n");
    write(path.join(ws.dir, "tracked.txt"), "new\n");
    commitWorkspace(ws, "during");
    restoreWorkspaceEdits(ws, snap);
    expect(fs.existsSync(path.join(ws.dir, "during.txt"))).toBe(false);
    expect(fs.existsSync(path.join(ws.dir, "tracked.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(ws.dir, "already.txt"), "utf8")).toBe("user\n");
    expect(agentGit(ws, ["rev-parse", "HEAD"])).toBe(snap.head);
  });
});

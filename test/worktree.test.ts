import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeSettings } from "../src/adapters/claude.js";
import { buildCodexInvocation } from "../src/adapters/codex.js";
import { runTeam } from "../src/dispatcher.js";
import { outboxDir, writePolicy } from "../src/policy.js";
import { prepareTask } from "../src/task.js";
import { validateProject } from "../src/validate.js";
import { assertWorktreeRunnable, collectAgentChanges, commitWorkspace, dirtyPaths, finishLeadBranch, inspectWorkspace, integrateAgentChanges, prepareAgentWorkspace, resolveWorkspaceMode, snapshotBase, snapshotHead } from "../src/worktree.js";
import { git, initGitRepo, makeConcurrent, makeEnv, makeParallel, write, type ClaudeSettingsView, type TestEnv } from "./helpers.js";
import type { ResolvedProject } from "../src/config.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const settings = (over: Partial<{ max_parallel: number; max_concurrent_runs: number; workspace_mode: "auto" | "shared" | "worktree" }>) => ({
  max_rounds: 30, max_parallel: 1, max_concurrent_runs: 1, wake_timeout_sec: 600, retry: 1, strict: false, workspace_mode: "auto" as const, log_max_bytes: 0, ...over,
});

describe("workspace mode", () => {
  it("uses worktrees for every run when several runs may be active at once", () => {
    expect(resolveWorkspaceMode(settings({ max_concurrent_runs: 2 }))).toBe("worktree");
    expect(resolveWorkspaceMode(settings({ max_concurrent_runs: 2, workspace_mode: "auto" }))).toBe("worktree");
    expect(resolveWorkspaceMode(settings({ max_concurrent_runs: 1 }))).toBe("shared");
  });

  it("uses worktrees when agents can run in parallel, or when asked to", () => {
    expect(resolveWorkspaceMode(settings({}))).toBe("shared");
    expect(resolveWorkspaceMode(settings({ max_parallel: 2 }))).toBe("worktree");
    expect(resolveWorkspaceMode(settings({ workspace_mode: "worktree" }))).toBe("worktree");
    expect(resolveWorkspaceMode(settings({ workspace_mode: "shared" }))).toBe("shared");
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

describe("validate", () => {
  const errors = (e: TestEnv) => validateProject(e.project()).issues.filter((i) => i.level === "error").map((i) => i.message);

  it("refuses shared workspaces together with parallel agents", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeParallel(env);
    env.editProjectYaml((t) => t.replace("workspace_mode: auto", "workspace_mode: shared"));
    expect(errors(env).join("\n")).toMatch(/workspace_mode.*shared.*max_parallel/);
  });

  it("refuses parallel agents in a folder that is not a git repository, but allows a sequential run", () => {
    env = makeEnv();
    expect(errors(env)).toEqual([]);
    makeParallel(env);
    expect(errors(env).join("\n")).toMatch(/git repository/);
    initGitRepo(env.repo);
    expect(errors(env)).toEqual([]);
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

describe("dispatcher with worktrees", () => {
  const OK = { ok: true, text: "", exitCode: 0, timedOut: false };
  const mail = (p: ResolvedProject, from: string, to: string, subject: string, type = "reply") =>
    write(path.join(outboxDir(p, from), `${Math.random()}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: partial\n" : ""}---\n\n${type === "done" ? "## Result\nx\n\n## Not done\nx\n" : "body"}\n`);

  async function start(invoker: Parameters<typeof runTeam>[0]["invoker"]) {
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    return runTeam({ project, task, runDir, invoker, log: () => {} });
  }

  it("runs members in their own checkouts while the lead keeps the main repo", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeParallel(env);
    const where: Record<string, string | undefined> = {};
    let leadCalls = 0;
    const s = await start(async (i) => {
      where[i.agent.name] = i.workspace?.dir;
      if (i.agent.name === "lead") {
        leadCalls++;
        if (leadCalls === 1) {
          write(path.join(env.repo, "src/web/from-lead.txt"), "lead\n");
          mail(i.project, "lead", "fe-member", "a", "task");
        } else mail(i.project, "lead", "lead", "bye", "done");
      } else {
        write(path.join(i.workspace!.dir, "src/web/from-fe.txt"), "fe\n");
        expect(fs.existsSync(path.join(i.workspace!.dir, "src/web/from-lead.txt"))).toBe(true);
        mail(i.project, i.agent.name, "lead", "r");
      }
      return OK;
    });
    expect(s.endReason).toBe("done");
    expect(where.lead).toBeUndefined();
    expect(where["fe-member"]).toBe(path.join(env.project().paths.root, "worktrees", "run-1", "fe-member"));
    expect(fs.readFileSync(path.join(env.repo, "src/web/from-fe.txt"), "utf8")).toBe("fe\n"); // brought into the main repo once fe-member finished
    expect(fs.existsSync(path.join(where["fe-member"]!, "src/web/from-fe.txt"))).toBe(true);
  });

  it("refuses to start a parallel run while the repo has uncommitted changes of its own", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeParallel(env);
    write(path.join(env.repo, "src/web/a.txt"), "my own unfinished edit\n");
    await expect(start(async () => OK)).rejects.toThrow(/uncommitted.*src\/web\/a\.txt/s);
    expect(fs.existsSync(path.join(env.project().paths.runs, "run-1", "state.json"))).toBe(false);
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
    expect(() => assertWorktreeRunnable(p, { fresh: true, concurrent: true })).not.toThrow();
    expect(() => assertWorktreeRunnable(p, { fresh: true })).toThrow(/uncommitted/);
    const ref = snapshotHead(p, "run-1");
    expect(ref).toBe("refs/agent-lyceum/run-1/base-0");
    expect(git(env.repo, "rev-parse", ref)).toBe(git(env.repo, "rev-parse", "HEAD"));
    const ws = prepareAgentWorkspace(p, "run-1", "lead", ref);
    expect(fs.readFileSync(path.join(ws.dir, "src/web/a.txt"), "utf8")).toBe("a\n"); // the edit is not part of the run
    expect(fs.readFileSync(path.join(env.repo, "src/web/a.txt"), "utf8")).toBe("uncommitted edit\n");
    expect(ws.branch).toBe("agent-lyceum/run-1/lead");
  });

  it("refuses a repository without any commit", () => {
    env = makeEnv();
    git(env.repo, "init", "-q", "-b", "main");
    makeConcurrent(env, 2);
    expect(() => assertWorktreeRunnable(env.project(), { fresh: true, concurrent: true })).toThrow(/no commit yet/);
  });

  it("snapshots the lead's worktree for members and brings a member's files into the lead's worktree, not the repo", () => {
    const p = concurrentRepo();
    const lead = prepareAgentWorkspace(p, "run-1", "lead", snapshotHead(p, "run-1"));
    write(path.join(lead.dir, "src/web/lead-note.txt"), "lead was here\n");
    const ref = snapshotBase(p, "run-1", 1, lead.root);
    const member = prepareAgentWorkspace(p, "run-1", "fe-member", ref);
    expect(fs.readFileSync(path.join(member.dir, "src/web/lead-note.txt"), "utf8")).toBe("lead was here\n");
    write(path.join(member.dir, "src/web/feature.txt"), "built\n");
    const r = integrateAgentChanges(p, collectAgentChanges(member, ["src/web/**"]), lead.root);
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
    expect(commitWorkspace(lead.root, "again")).toMatchObject({ committed: false, head: rb.head });
    expect(git(env.repo, "status", "--porcelain")).toBe("");
    // merging the branch brings the work in
    git(env.repo, "merge", "-q", "--no-edit", rb.branch);
    expect(fs.readFileSync(path.join(env.repo, "src/web/new.txt"), "utf8")).toBe("new\n");
  });

  it("inspectWorkspace compares a member with the lead's worktree, and the lead with the repo", () => {
    const p = concurrentRepo();
    const lead = prepareAgentWorkspace(p, "run-1", "lead", snapshotHead(p, "run-1"));
    const ref = snapshotBase(p, "run-1", 1, lead.root);
    const member = prepareAgentWorkspace(p, "run-1", "fe-member", ref);
    write(path.join(member.dir, "src/web/feature.txt"), "built\n");
    integrateAgentChanges(p, collectAgentChanges(member, ["src/web/**"]), lead.root);
    // the member's file is in the lead's worktree, so the member holds nothing that exists nowhere else
    expect(inspectWorkspace(p, "run-1", "fe-member", lead.root)?.unintegrated).toEqual([]);
    // the lead's worktree holds it, and the repo does not have it yet
    expect(inspectWorkspace(p, "run-1", "lead")?.dirty).toContain("src/web/feature.txt");
    finishLeadBranch(lead, "m", path.join(env.root, "p.patch"));
    expect(inspectWorkspace(p, "run-1", "lead")?.unintegrated).toContain("src/web/feature.txt");
    git(env.repo, "merge", "-q", "--no-edit", lead.branch);
    expect(inspectWorkspace(p, "run-1", "lead")?.unintegrated).toEqual([]);
  });
});

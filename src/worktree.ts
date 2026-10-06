import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedProject } from "./config.js";
import { atomicWrite } from "./fs-util.js";
import type { DispatcherSettings } from "./schema.js";

export type WorkspaceMode = "shared" | "worktree";

/** Agents share the repo, or each non-lead agent gets its own git worktree. `auto` picks worktrees as soon as agents can run in parallel. */
export function resolveWorkspaceMode(d: Pick<DispatcherSettings, "workspace_mode" | "max_parallel">): WorkspaceMode {
  if (d.workspace_mode === "worktree") return "worktree";
  if (d.workspace_mode === "shared") return "shared";
  return d.max_parallel > 1 ? "worktree" : "shared";
}

export interface AgentWorkspace {
  agent: string;
  /** Root of the git worktree. */
  root: string;
  /** Where the agent works: the worktree's counterpart of the project dir (differs from `root` when the project is a subfolder of the repo). */
  dir: string;
  /** The worktree's private git dir inside the main repo's `.git/worktrees/`. */
  gitDir: string;
  branch: string;
  /** Commit of the snapshot this workspace's changes are measured against. */
  base: string;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "agent-team",
  GIT_AUTHOR_EMAIL: "agent-team@localhost",
  GIT_COMMITTER_NAME: "agent-team",
  GIT_COMMITTER_EMAIL: "agent-team@localhost",
};

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }).replace(/\n$/, "");
}

function tryGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string | undefined {
  try {
    return git(cwd, args, env);
  } catch {
    return undefined;
  }
}

export function isGitRepo(dir: string): boolean {
  return tryGit(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

const toplevel = (dir: string): string => git(dir, ["rev-parse", "--show-toplevel"]);

/** Files in the repo with changes nobody committed (modified, staged or new and not ignored). Paths are relative to the repo root. */
export function dirtyPaths(dir: string): string[] {
  const out = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const parts = out.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++; // a rename lists its old name next
  }
  return paths;
}

/** Refuse to start a worktree run when it cannot be isolated; returns nothing when it is fine. */
export function assertWorktreeRunnable(project: ResolvedProject, opts: { fresh: boolean }): void {
  if (!isGitRepo(project.dir)) {
    throw new Error(`Parallel runs (worktree workspaces) need ${project.dir} to be a git repository. Run sequentially instead: dispatcher.max_parallel: 1.`);
  }
  if (!opts.fresh) return;
  const dirty = dirtyPaths(project.dir);
  if (dirty.length) {
    const shown = dirty.slice(0, 5).join(", ") + (dirty.length > 5 ? `, ... (${dirty.length} in all)` : "");
    throw new Error(
      `Parallel runs start from a clean repo, but ${project.dir} has uncommitted changes: ${shown}. ` +
        `Commit or stash them first (agent-team never touches your own edits), or run sequentially with dispatcher.max_parallel: 1.`,
    );
  }
}

/**
 * Commit the repo's current working tree (tracked changes and new, non-ignored files) as an unreferenced-by-branch
 * snapshot `refs/agent-team/<run>/base-<n>`. Uses a throwaway index, so HEAD, branches, the real index and the
 * working tree are not touched. Returns the ref.
 */
export function snapshotBase(project: ResolvedProject, runId: string, n: number): string {
  const top = toplevel(project.dir);
  const index = path.join(os.tmpdir(), `agent-team-index-${crypto.randomBytes(6).toString("hex")}`);
  const env = { ...IDENTITY, GIT_INDEX_FILE: index };
  try {
    const head = tryGit(top, ["rev-parse", "--verify", "HEAD"]);
    if (head) git(top, ["read-tree", head], env);
    git(top, ["add", "-A"], env);
    const tree = git(top, ["write-tree"], env);
    const commit = git(top, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `agent-team snapshot ${runId} #${n}`], env);
    const ref = `refs/agent-team/${runId}/base-${n}`;
    git(top, ["update-ref", ref, commit]);
    return ref;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

interface WorkspaceMeta {
  branch: string;
  base: string;
}

const workspaceRoot = (project: ResolvedProject, runId: string, agent: string): string => path.join(project.paths.root, "worktrees", runId, agent);

function describeWorkspace(project: ResolvedProject, root: string, agent: string, meta: WorkspaceMeta): AgentWorkspace {
  const top = toplevel(project.dir);
  // `top` is a real path (git resolves symlinks, e.g. /var -> /private/var on macOS), so compare against the real project dir.
  const rel = path.relative(top, fs.realpathSync(project.dir));
  return {
    agent,
    root,
    dir: rel ? path.join(root, rel) : root,
    gitDir: git(root, ["rev-parse", "--absolute-git-dir"]),
    branch: meta.branch,
    base: meta.base,
  };
}

/**
 * The agent's own checkout of the snapshot `baseRef`, at `<project home>/worktrees/<run>/<agent>`.
 * An existing checkout is reused: untouched, when it already is on this snapshot (resume) or holds unfinished
 * work; moved to the new snapshot when it is clean and nothing was done in it.
 */
export function prepareAgentWorkspace(project: ResolvedProject, runId: string, agent: string, baseRef: string): AgentWorkspace {
  const top = toplevel(project.dir);
  const root = workspaceRoot(project, runId, agent);
  const metaFile = `${root}.json`;
  const newBase = git(top, ["rev-parse", `${baseRef}^{commit}`]);

  let meta: WorkspaceMeta | undefined;
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as WorkspaceMeta;
  } catch {
    meta = undefined;
  }

  if (meta && fs.existsSync(root)) {
    if (meta.base !== newBase) {
      const untouched = git(root, ["status", "--porcelain", "--untracked-files=all"]) === "" && git(root, ["rev-parse", "HEAD"]) === meta.base;
      if (untouched) {
        git(root, ["reset", "-q", "--hard", newBase]);
        meta = { ...meta, base: newBase };
        atomicWrite(metaFile, JSON.stringify(meta, null, 2));
      }
    }
    return describeWorkspace(project, root, agent, meta);
  }

  const branch = `agent-team/${runId}/${agent}`;
  fs.mkdirSync(path.dirname(root), { recursive: true });
  git(top, ["worktree", "add", "-q", "-B", branch, root, newBase]);
  meta = { branch, base: newBase };
  atomicWrite(metaFile, JSON.stringify(meta, null, 2));
  return describeWorkspace(project, root, agent, meta);
}

/** Remove an agent's worktree, its branch and its metadata. The caller decides whether the work in it may be discarded. */
export function removeAgentWorkspace(project: ResolvedProject, runId: string, agent: string): void {
  const top = toplevel(project.dir);
  const root = workspaceRoot(project, runId, agent);
  let branch: string | undefined;
  try {
    branch = (JSON.parse(fs.readFileSync(`${root}.json`, "utf8")) as WorkspaceMeta).branch;
  } catch {
    /* no metadata */
  }
  if (fs.existsSync(root)) tryGit(top, ["worktree", "remove", "--force", root]);
  fs.rmSync(root, { recursive: true, force: true });
  tryGit(top, ["worktree", "prune"]);
  if (branch) tryGit(top, ["branch", "-D", branch]);
  fs.rmSync(`${root}.json`, { force: true });
}

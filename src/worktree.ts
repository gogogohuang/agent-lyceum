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
  GIT_AUTHOR_NAME: "agent-lyceum",
  GIT_AUTHOR_EMAIL: "agent-lyceum@localhost",
  GIT_COMMITTER_NAME: "agent-lyceum",
  GIT_COMMITTER_EMAIL: "agent-lyceum@localhost",
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
    const entry = parts[i] ?? "";
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
        `Commit or stash them first (agent-lyceum never touches your own edits), or run sequentially with dispatcher.max_parallel: 1.`,
    );
  }
}

/**
 * Commit the repo's current working tree (tracked changes and new, non-ignored files) as an unreferenced-by-branch
 * snapshot `refs/agent-lyceum/<run>/base-<n>`. Uses a throwaway index, so HEAD, branches, the real index and the
 * working tree are not touched. Returns the ref.
 */
export function snapshotBase(project: ResolvedProject, runId: string, n: number): string {
  const top = toplevel(project.dir);
  const index = path.join(os.tmpdir(), `agent-lyceum-index-${crypto.randomBytes(6).toString("hex")}`);
  const env = { ...IDENTITY, GIT_INDEX_FILE: index };
  try {
    const head = tryGit(top, ["rev-parse", "--verify", "HEAD"]);
    if (head) git(top, ["read-tree", head], env);
    git(top, ["add", "-A"], env);
    const tree = git(top, ["write-tree"], env);
    const commit = git(top, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `agent-lyceum snapshot ${runId} #${n}`], env);
    const ref = `refs/agent-lyceum/${runId}/base-${n}`;
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

  const branch = `agent-lyceum/${runId}/${agent}`;
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

// ---- collecting and integrating an agent's changes ----

export interface ChangedFile {
  /** Relative to the repo root. */
  path: string;
  status: "A" | "M" | "D" | "T";
  /** File mode after the change ("120000" = symlink, "160000" = submodule). */
  mode: string;
}

export interface ChangeSet {
  workspace: AgentWorkspace;
  /** The snapshot commit the changes are measured against. */
  base: string;
  /** The agent's branch tip after its changes were committed. */
  head: string;
  files: ChangedFile[];
  /** Why these changes may not be integrated (empty when they may). */
  violations: string[];
}

/** Glob as used in `owns`: `**` crosses folders, `*` and `?` stay within one, `{a,b}` alternates. */
export function globMatch(glob: string, file: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\}]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(file);
}

const PROTECTED_NAMES = ["CLAUDE.md", "AGENTS.md"];

/**
 * Commit whatever the agent left in its worktree and list what changed since its snapshot, checking every
 * changed path (modified, added, deleted, or either end of a rename) against the agent's `owns`, the project
 * folder, the protected instruction files, and symlink/submodule rules. Nothing is applied here.
 */
export function collectAgentChanges(workspace: AgentWorkspace, owns: string[]): ChangeSet {
  const { root } = workspace;
  git(root, ["add", "-A"]);
  if (tryGit(root, ["diff", "--cached", "--quiet"]) === undefined) {
    // hooks belong to the user's repo (a worktree shares them): do not run them for the dispatcher's own commit
    git(root, ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", `agent-lyceum: changes by ${workspace.agent}`], IDENTITY);
  }
  const head = git(root, ["rev-parse", "HEAD"]);
  const base = workspace.base;
  const raw = base === head ? "" : execFileSync("git", ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", base, head], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const parts = raw.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d+) (\d+) \w+ \w+ (\w)$/.exec(parts[i] ?? "");
    if (!m) continue;
    files.push({ path: parts[i + 1] ?? "", status: m[3] as ChangedFile["status"], mode: m[2] ?? "" });
  }

  const rel = path.relative(workspace.root, workspace.dir).split(path.sep).join("/");
  const violations: string[] = [];
  for (const f of files) {
    const inProject = rel === "" || f.path === rel || f.path.startsWith(`${rel}/`);
    if (!inProject) {
      violations.push(`${f.path}: outside the project directory (${rel})`);
      continue;
    }
    const p = rel === "" ? f.path : path.posix.relative(rel, f.path);
    if (PROTECTED_NAMES.includes(p)) violations.push(`${f.path}: protected instruction file; only the lead may change it, by hand`);
    const allowed = (candidate: string) => owns.length === 0 || owns.some((g) => globMatch(g, candidate));
    if (!allowed(p)) violations.push(`${f.path}: outside this agent's owns (${owns.join(", ")})`);
    if (f.mode === "160000") violations.push(`${f.path}: submodule changes are not integrated`);
    if (f.mode === "120000" && f.status !== "D") {
      const target = git(root, ["show", `${head}:${f.path}`]);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(p), target));
      if (path.posix.isAbsolute(target)) violations.push(`${f.path}: symlink to an absolute path (${target})`);
      else if (resolved.startsWith("..")) violations.push(`${f.path}: symlink leaves the project directory (${target})`);
      else if (!allowed(resolved)) violations.push(`${f.path}: symlink points outside this agent's owns (${target})`);
    }
  }
  return { workspace, base, head, files, violations };
}

export type IntegrationResult =
  | { status: "integrated"; files: ChangedFile[]; applied: number }
  | { status: "blocked"; reason: string; branch: string; workspace: string; report: string; patch: string };

function blobAt(top: string, commit: string, file: string): string {
  return tryGit(top, ["rev-parse", "--verify", "-q", `${commit}:${file}`]) ?? "absent";
}

/** Git's blob id of what is in the main working tree at `file`, or "absent". */
function workingBlob(top: string, file: string): string {
  const abs = path.join(top, file);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return "absent";
  }
  if (st.isDirectory()) return "directory";
  const input = st.isSymbolicLink() ? fs.readlinkSync(abs) : fs.readFileSync(abs);
  return execFileSync("git", ["hash-object", "--stdin"], { cwd: top, input, encoding: "utf8" }).trim();
}

function writeBlockedReport(project: ResolvedProject, changes: ChangeSet, reason: string, patch: string): { report: string; patch: string } {
  const dir = path.join(project.run?.dir ?? project.paths.root, "integration");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const base = path.join(dir, `${changes.workspace.agent}-${stamp}`);
  fs.writeFileSync(`${base}.patch`, patch);
  fs.writeFileSync(
    `${base}.md`,
    [
      `# ${changes.workspace.agent}: changes not integrated`,
      "",
      reason,
      "",
      `- agent branch: \`${changes.workspace.branch}\` (kept)`,
      `- agent worktree: \`${changes.workspace.root}\` (kept)`,
      `- snapshot it started from: \`${changes.base}\``,
      `- its changes as a patch: \`${base}.patch\` (apply with \`git apply\`)`,
      "",
      "## Files",
      ...changes.files.map((f) => `- ${f.status} ${f.path}`),
      "",
    ].join("\n"),
  );
  return { report: `${base}.md`, patch: `${base}.patch` };
}

function advanceBase(workspace: AgentWorkspace, newBase: string): void {
  const metaFile = `${workspace.root}.json`;
  atomicWrite(metaFile, JSON.stringify({ branch: workspace.branch, base: newBase }, null, 2));
}

/**
 * Bring an agent's collected changes into the main working tree (not the index, not HEAD), all or nothing.
 * Blocked, with nothing applied and the agent's work kept, when the changes break the rules, when a file
 * changed in the repo since the agent's snapshot, or when git cannot apply the patch. Repeating a call whose
 * changes are already in place is harmless.
 */
export function integrateAgentChanges(project: ResolvedProject, changes: ChangeSet): IntegrationResult {
  const top = toplevel(project.dir);
  const { workspace, base, head } = changes;
  const fullPatch = (paths: string[]): string =>
    paths.length === 0 ? "" : git(top, ["--literal-pathspecs", "diff", "--binary", "--full-index", base, head, "--", ...paths]) + "\n";
  const block = (reason: string, paths = changes.files.map((f) => f.path)): IntegrationResult => ({
    status: "blocked",
    reason,
    branch: workspace.branch,
    workspace: workspace.root,
    ...writeBlockedReport(project, changes, reason, fullPatch(paths)),
  });

  if (changes.violations.length) return block(`These changes break the rules, so none were applied:\n${changes.violations.map((v) => `- ${v}`).join("\n")}`);
  if (changes.files.length === 0) return { status: "integrated", files: [], applied: 0 };

  const pending: ChangedFile[] = [];
  const conflicts: string[] = [];
  for (const f of changes.files) {
    const work = workingBlob(top, f.path);
    if (work === blobAt(top, head, f.path)) continue; // already in place
    if (work === blobAt(top, base, f.path)) pending.push(f);
    else conflicts.push(f.path);
  }
  if (conflicts.length) {
    return block(
      `${conflicts.join(", ")} changed since the snapshot the agent started from (the file in the repo now differs from both the agent's start and its result), so none of its changes were applied.`,
    );
  }
  if (pending.length) {
    const patch = fullPatch(pending.map((f) => f.path));
    try {
      execFileSync("git", ["apply", "--binary", "--whitespace=nowarn", "-"], { cwd: top, input: patch, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      return block(`git could not apply the patch, so none of the changes were applied: ${(err.stderr || err.message).trim()}`);
    }
  }
  advanceBase(workspace, head);
  return { status: "integrated", files: changes.files, applied: pending.length };
}

/** An agent's existing worktree for this run, if it has one. */
export function existingAgentWorkspace(project: ResolvedProject, runId: string, agent: string): AgentWorkspace | undefined {
  const root = workspaceRoot(project, runId, agent);
  try {
    const meta = JSON.parse(fs.readFileSync(`${root}.json`, "utf8")) as WorkspaceMeta;
    return fs.existsSync(root) ? describeWorkspace(project, root, agent, meta) : undefined;
  } catch {
    return undefined;
  }
}

export interface WorkspaceWork {
  agent: string;
  root: string;
  branch: string;
  /** Uncommitted changes in the worktree (repo-relative paths). */
  dirty: string[];
  /** Files the agent committed that are not in the repo yet. */
  unintegrated: string[];
  /** Set when the state could not be determined; treat as work that must not be deleted. */
  unknown?: string;
}

/** What is in an agent's worktree that exists nowhere else: uncommitted changes, and commits whose files are not in the main repo. */
export function inspectWorkspace(project: ResolvedProject, runId: string, agent: string): WorkspaceWork | undefined {
  const root = workspaceRoot(project, runId, agent);
  if (!fs.existsSync(root)) return undefined;
  const ws = existingAgentWorkspace(project, runId, agent);
  const branch = ws?.branch ?? `agent-lyceum/${runId}/${agent}`;
  const work: WorkspaceWork = { agent, root, branch, dirty: [], unintegrated: [] };
  if (!ws) return { ...work, unknown: "its metadata is missing, so what it holds cannot be compared with the repo" };
  try {
    work.dirty = dirtyPaths(root);
    const top = toplevel(project.dir);
    const head = git(root, ["rev-parse", "HEAD"]);
    if (head !== ws.base && tryGit(top, ["merge-base", "--is-ancestor", head, "HEAD"]) === undefined) {
      const raw = execFileSync("git", ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", ws.base, head], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      const parts = raw.split("\0").filter(Boolean);
      for (let i = 1; i < parts.length; i += 2) {
        const file = parts[i] ?? "";
        if (workingBlob(top, file) !== blobAt(top, head, file)) work.unintegrated.push(file);
      }
    }
  } catch (e) {
    work.unknown = `its state could not be read (${(e as Error).message.split("\n")[0]})`;
  }
  return work;
}

/** Names of the agents that have a worktree for this run. */
export function listWorkspaceAgents(project: ResolvedProject, runId: string): string[] {
  const dir = path.join(project.paths.root, "worktrees", runId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** The snapshot refs (`refs/agent-lyceum/<run>/...`) of a run. */
export function listSnapshotRefs(project: ResolvedProject, runId: string): string[] {
  if (!isGitRepo(project.dir)) return [];
  const out = tryGit(project.dir, ["for-each-ref", "--format=%(refname)", `refs/agent-lyceum/${runId}/`]) ?? "";
  return out.split("\n").filter(Boolean);
}

export function deleteSnapshotRefs(project: ResolvedProject, runId: string): void {
  for (const ref of listSnapshotRefs(project, runId)) git(project.dir, ["update-ref", "-d", ref]);
}

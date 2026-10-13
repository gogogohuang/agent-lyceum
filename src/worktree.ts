import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedProject } from "./config.js";
import { atomicWrite } from "./fs-util.js";
import type { DispatcherSettings } from "./schema.js";

export type WorkspaceMode = "shared" | "worktree";

/** Agents share the repo, or each non-lead agent gets its own git worktree. `auto` picks worktrees as soon as agents can run in parallel; several concurrent runs always do. */
export function resolveWorkspaceMode(
  d: Pick<DispatcherSettings, "workspace_mode" | "max_parallel"> & Partial<Pick<DispatcherSettings, "max_concurrent_runs">>,
): WorkspaceMode {
  if ((d.max_concurrent_runs ?? 1) > 1) return "worktree";
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
  /** The worktree's private git dir inside the main repo's `.git/worktrees/`. Recorded when the worktree was made, never asked of the worktree. */
  gitDir: string;
  /** The main repo's git dir (absolute, real path): where config, hooks, objects and refs live. Recorded with `gitDir`. */
  commonDir: string;
  /** Fingerprint of `<gitDir>/config.worktree` when the worktree was made; absent when there was none. */
  worktreeConfig?: string;
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

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string | Buffer): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input,
    env: { ...process.env, ...env },
  }).replace(/\n$/, "");
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return runGit(cwd, args, env);
}

function tryGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string | undefined {
  try {
    return git(cwd, args, env);
  } catch {
    return undefined;
  }
}

// ---- git in an agent's worktree ----

/**
 * What the dispatcher never lets git take from a place an agent can write. Each one was seen running a planted program:
 * fsmonitor and hooks (post-commit runs despite --no-verify); a nested repository in the worktree, which `status` and `add`
 * otherwise visit with git reading that repository's own config (its fsmonitor and filters); `submodule.recurse` / `diff.submodule`
 * would do the same for reset and diff; signing runs gpg.program.
 */
const PINNED_CONFIG = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "diff.ignoreSubmodules=dirty",
  "-c", "submodule.recurse=false",
  "-c", "diff.submodule=short",
  "-c", "commit.gpgsign=false",
];
/** Added to every diff/show/log: no external diff program, no textconv program. */
const DIFF_PINS = ["--no-ext-diff", "--no-textconv"];
const DIFF_COMMANDS = new Set(["diff", "show", "log"]);

type PinnedWorkspace = Pick<AgentWorkspace, "root" | "gitDir" | "commonDir" | "worktreeConfig" | "branch">;

const fingerprint = (file: string): string | undefined => {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return undefined;
  }
  if (!st.isFile()) return `not a regular file (${st.isSymbolicLink() ? "symlink" : "other"})`;
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
};

const samePath = (a: string, b: string): boolean => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
};

/**
 * Refuse a worktree whose git files were rewritten in a way pinning cannot neutralise:
 * - `commondir`: git's ref store follows it even with GIT_COMMON_DIR set, so refs would be read from and written to the agent's dir;
 * - `config.worktree` (read when the user enabled extensions.worktreeConfig): it can name filters, chosen by the worktree's own
 *   .gitattributes, and a signing program — more than any `-c` list can switch off;
 * - files git writes by following links (COMMIT_EDITMSG, logs/HEAD): a symlink or hard link would make git write outside the sandbox;
 * - `HEAD` not the worktree's own branch: the ref store is shared, so a HEAD naming another branch (say `main`) or a detached
 *   commit would make the dispatcher commit onto, or measure against, a ref the agent chose. git writes exactly
 *   `ref: refs/heads/<branch>\n` and keeps it so through the dispatcher's commits and `reset --hard`;
 * - the worktree or its git dir replaced by a symlink.
 */
export function assertWorkspaceIntact(ws: PinnedWorkspace): void {
  const problems: string[] = [];
  const realDir = (p: string): boolean => {
    try {
      return fs.lstatSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  if (!realDir(ws.root)) problems.push(`${ws.root} is not a plain directory`);
  if (!realDir(ws.gitDir)) problems.push(`its git dir ${ws.gitDir} is not a plain directory`);
  else {
    let commondir: string | undefined;
    try {
      commondir = fs.readFileSync(path.join(ws.gitDir, "commondir"), "utf8").trim();
    } catch {
      commondir = undefined;
    }
    if (commondir === undefined || !samePath(path.resolve(ws.gitDir, commondir), ws.commonDir)) problems.push(`${path.join(ws.gitDir, "commondir")} no longer points at ${ws.commonDir}`);
    if (fingerprint(path.join(ws.gitDir, "config.worktree")) !== ws.worktreeConfig) problems.push(`${path.join(ws.gitDir, "config.worktree")} changed since the worktree was made`);
    for (const name of ["logs", "logs/HEAD", "COMMIT_EDITMSG"]) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(ws.gitDir, name));
      } catch {
        continue;
      }
      const ok = name === "logs" ? st.isDirectory() : st.isFile() && st.nlink === 1;
      if (!ok) problems.push(`${path.join(ws.gitDir, name)} is a link or not what git made`);
    }
    const head = path.join(ws.gitDir, "HEAD");
    let headOk = false;
    try {
      const st = fs.lstatSync(head);
      headOk = st.isFile() && st.nlink === 1 && fs.readFileSync(head, "utf8") === `ref: refs/heads/${ws.branch}\n`;
    } catch {
      headOk = false;
    }
    if (!headOk) problems.push(`${head} is not a plain file naming its own branch ${ws.branch}`);
  }
  if (problems.length) {
    throw new Error(
      `Refusing to run git in the worktree ${ws.root}: ${problems.join("; ")}. Its git files were changed after it was made (an agent can write them); nothing in it was touched. ` +
        `The work in it is still there and nothing was deleted. \`agent-lyceum clear\` will refuse this worktree too, because it counts as holding work: inspect it, and once you are sure it is safe, remove it by hand with \`git worktree remove --force <path>\`.`,
    );
  }
}

function pinnedArgs(args: string[]): string[] {
  const i = args.findIndex((a) => !a.startsWith("-"));
  const withDiffPins = i >= 0 && DIFF_COMMANDS.has(args[i] ?? "") ? [...args.slice(0, i + 1), ...DIFF_PINS, ...args.slice(i + 1)] : args;
  return [...PINNED_CONFIG, ...withDiffPins];
}

function pinnedEnv(ws: PinnedWorkspace, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, GIT_DIR: ws.gitDir, GIT_COMMON_DIR: ws.commonDir, GIT_WORK_TREE: ws.root };
}

/**
 * Run git against an agent's worktree without letting git discover anything from it. The agent may rewrite the worktree's `.git`
 * pointer file and its per-worktree git dir; git is told exactly where the git dir, the common dir and the work tree are
 * (`ws.gitDir` / `ws.commonDir` come from the workspace meta, recorded before any agent ran in it), and the worktree is checked
 * for what pinning cannot neutralise first (`assertWorkspaceIntact`).
 * The cwd is the worktree root: git does not discover from it (GIT_DIR is set), and commands that take paths relative to the cwd
 * (`git apply`) would otherwise write wherever the cwd is.
 */
export function agentGit(ws: PinnedWorkspace, args: string[], env: NodeJS.ProcessEnv = {}, input?: string | Buffer): string {
  assertWorkspaceIntact(ws);
  return runGit(ws.root, pinnedArgs(args), pinnedEnv(ws, env), input);
}

/** `agentGit`, with a failing git command giving `undefined`. A worktree that fails `assertWorkspaceIntact` still throws. */
export function tryAgentGit(ws: PinnedWorkspace, args: string[], env?: NodeJS.ProcessEnv): string | undefined {
  assertWorkspaceIntact(ws);
  try {
    return runGit(ws.root, pinnedArgs(args), pinnedEnv(ws, env ?? {}));
  } catch {
    return undefined;
  }
}

const zList = (out: string): string[] => out.split("\0").filter(Boolean);
/** Paths of the gitlink (mode 160000) entries in `git ls-files -s -z` / `git ls-tree -r -z` output. */
const gitlinks = (out: string): string[] =>
  zList(out)
    .filter((e) => e.startsWith("160000 "))
    .map((e) => e.slice(e.indexOf("\t") + 1));

/**
 * Refuse a worktree that holds a git repository of its own. `status`, `add -A` and `commit` can visit a nested repository and run
 * git there with that repository's config — which the agent wrote. Run before any command that walks the working tree.
 * - untracked: `ls-files -o` (it does not enter them, and runs nothing) lists a nested repository as one entry ending in `/`;
 * - a submodule entry in the (agent-writable) index that the snapshot did not have;
 * - a submodule path from the snapshot that now holds a repository (`git worktree add` never fills it, and an agent cannot).
 * A repo that uses submodules keeps working: its submodule entries come from the snapshot and stay empty in a worktree.
 */
export function assertNoNestedRepos(ws: AgentWorkspace): void {
  const problems: string[] = [];
  for (const p of zList(agentGit(ws, ["ls-files", "-o", "--exclude-standard", "-z"])).filter((e) => e.endsWith("/"))) {
    problems.push(`it contains a nested git repository at ${p.slice(0, -1)}; remove it, or add it to .gitignore if it must stay`);
  }
  const allowed = new Set(gitlinks(agentGit(ws, ["ls-tree", "-r", "-z", ws.base])));
  for (const p of gitlinks(agentGit(ws, ["ls-files", "-s", "-z"]))) {
    if (!allowed.has(p)) problems.push(`its index has a submodule entry ${p} that the snapshot it started from does not have`);
    else if (fs.existsSync(path.join(ws.root, p, ".git"))) problems.push(`a git repository was placed at the submodule path ${p}`);
  }
  if (problems.length) throw new Error(`Refusing to run git in the worktree ${ws.root}: ${problems.join("; ")}. Nothing in it was touched.`);
}

/** Where a function runs git: an agent's worktree (pinned), or, when undefined, the user's own repo at `top`. */
type GitAt = { ws: AgentWorkspace } | { top: string };
const gitAt = (at: GitAt, args: string[], env?: NodeJS.ProcessEnv, input?: string | Buffer): string => ("ws" in at ? agentGit(at.ws, args, env, input) : runGit(at.top, args, env, input));
const tryGitAt = (at: GitAt, args: string[], env?: NodeJS.ProcessEnv): string | undefined => ("ws" in at ? tryAgentGit(at.ws, args, env) : tryGit(at.top, args, env));
const workTreeOf = (at: GitAt): string => ("ws" in at ? at.ws.root : at.top);

/** Paths in `git status --porcelain -z` output. */
function parseStatus(out: string): string[] {
  const parts = out.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? "";
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++; // a rename lists its old name next
  }
  return paths;
}

export function isGitRepo(dir: string): boolean {
  return tryGit(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/** The main repository's top-level directory for `dir`. */
export const toplevel = (dir: string): string => git(dir, ["rev-parse", "--show-toplevel"]);

/** Files in the repo with changes nobody committed (modified, staged or new and not ignored). Paths are relative to the repo root. */
export function dirtyPaths(dir: string): string[] {
  return parseStatus(execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
}

/** Refuse to start a worktree run when it cannot be isolated; returns nothing when it is fine. */
export function assertWorktreeRunnable(project: ResolvedProject, opts: { fresh: boolean; concurrent?: boolean }): void {
  if (!isGitRepo(project.dir)) {
    throw new Error(`Parallel runs (worktree workspaces) need ${project.dir} to be a git repository. Run sequentially instead: dispatcher.max_parallel: 1.`);
  }
  // With git's reftable ref storage a linked worktree's HEAD lives in `<gitDir>/reftable/`, a place the agent can write, and the
  // file `<gitDir>/HEAD` only says `ref: refs/heads/.invalid`: the check that a worktree's HEAD is its own branch cannot hold
  // there, so every worktree would be refused in the middle of the run. Say so up front instead. (`rev-parse --show-ref-format`
  // does not exist in older git, which only knows `files`.)
  if (tryGit(project.dir, ["rev-parse", "--show-ref-format"]) === "reftable") {
    throw new Error(
      `${project.dir} uses git's reftable ref storage, whose worktrees agent-lyceum cannot yet verify as isolated, so parallel agents and concurrent runs are not supported there. ` +
        `Use a repository with the default "files" ref storage, or run one agent at a time without worktrees: dispatcher.max_parallel: 1 and dispatcher.max_concurrent_runs: 1.`,
    );
  }
  if (!opts.fresh) return;
  if (opts.concurrent) {
    // A concurrent run starts from HEAD and never touches the working tree, so uncommitted changes are fine.
    if (tryGit(project.dir, ["rev-parse", "--verify", "-q", "HEAD"]) === undefined) {
      throw new Error(`Concurrent runs start from HEAD, but ${project.dir} has no commit yet. Make an initial commit, or set dispatcher.max_concurrent_runs: 1.`);
    }
    return;
  }
  const dirty = dirtyPaths(project.dir);
  if (dirty.length) {
    const shown = dirty.slice(0, 5).join(", ") + (dirty.length > 5 ? `, ... (${dirty.length} in all)` : "");
    throw new Error(
      `Parallel runs start from a clean repo, but ${project.dir} has uncommitted changes: ${shown}. ` +
        `Commit or stash them first (agent-lyceum never touches your own edits), or run sequentially with dispatcher.max_parallel: 1.`,
    );
  }
}

/** `refs/agent-lyceum/<run>/base-0` pointing at the repo's HEAD: where a concurrent run starts. Nothing in the repo changes. */
export function snapshotHead(project: ResolvedProject, runId: string): string {
  const top = toplevel(project.dir);
  const sha = git(top, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const ref = `refs/agent-lyceum/${runId}/base-0`;
  git(top, ["update-ref", ref, sha]);
  return ref;
}

/**
 * Commit the repo's current working tree (tracked changes and new, non-ignored files) as an unreferenced-by-branch
 * snapshot `refs/agent-lyceum/<run>/base-<n>`. Uses a throwaway index, so HEAD, branches, the real index and the
 * working tree are not touched. Returns the ref.
 * `from`: the checkout to snapshot — the lead's worktree in a concurrent run; by default your repo's working tree.
 */
export function snapshotBase(project: ResolvedProject, runId: string, n: number, from?: AgentWorkspace): string {
  const at: GitAt = from ? { ws: from } : { top: toplevel(project.dir) };
  const index = path.join(os.tmpdir(), `agent-lyceum-index-${crypto.randomBytes(6).toString("hex")}`);
  const env = { ...IDENTITY, GIT_INDEX_FILE: index };
  try {
    if (from) assertNoNestedRepos(from);
    const head = tryGitAt(at, ["rev-parse", "--verify", "HEAD"]);
    if (head) gitAt(at, ["read-tree", head], env);
    gitAt(at, ["add", "-A"], env);
    const tree = gitAt(at, ["write-tree"], env);
    const commit = gitAt(at, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `agent-lyceum snapshot ${runId} #${n}`], env);
    const ref = `refs/agent-lyceum/${runId}/base-${n}`;
    gitAt(at, ["update-ref", ref, commit]);
    return ref;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

interface WorkspaceMeta {
  branch: string;
  base: string;
  /** Recorded when the worktree is made (absent in meta written by older versions). */
  gitDir?: string;
  commonDir?: string;
  worktreeConfig?: string;
}

const workspaceRoot = (project: ResolvedProject, runId: string, agent: string): string => path.join(project.paths.root, "worktrees", runId, agent);

/** The user's repo's git common dir, as a real absolute path. Asked of the user's repo, never of a worktree. */
const commonDirOf = (top: string): string => fs.realpathSync(git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));

/** The admin dirs under `<commonDir>/worktrees/` whose `gitdir` file names `<root>/.git` (the file may hold a relative path). */
function adminDirsNaming(commonDir: string, root: string, names?: string[]): string[] {
  const admin = path.join(commonDir, "worktrees");
  let entries: string[];
  try {
    entries = names ?? fs.readdirSync(admin);
  } catch {
    entries = [];
  }
  const want = path.join(root, ".git");
  return entries
    .map((n) => path.join(admin, n))
    .filter((d) => {
      try {
        return samePath(path.resolve(d, fs.readFileSync(path.join(d, "gitdir"), "utf8").trim()), want);
      } catch {
        return false;
      }
    });
}

function writeMeta(root: string, meta: WorkspaceMeta): void {
  atomicWrite(`${root}.json`, JSON.stringify(meta, null, 2));
}

/**
 * The meta of a worktree made by an older version lacks `gitDir`/`commonDir`: take the common dir from the user's repo and the git
 * dir from the one admin dir that names this worktree. Anything but exactly one is refused rather than guessed (an agent can
 * rewrite its own admin dir's `gitdir` to claim another worktree). The result is written back to the meta.
 */
function completeLegacyMeta(top: string, root: string, meta: WorkspaceMeta): WorkspaceMeta {
  if (meta.gitDir && meta.commonDir) return meta;
  const commonDir = commonDirOf(top);
  const found = adminDirsNaming(commonDir, root);
  if (found.length !== 1) {
    throw new Error(
      `Cannot tell which git dir belongs to the worktree ${root}: its metadata predates recording it, and ${found.length} git dirs under ${path.join(commonDir, "worktrees")} name it${found.length ? ` (${found.join(", ")})` : ""}. ` +
        `Refusing to guess. Inspect it by hand, or remove it with \`git worktree remove\`.`,
    );
  }
  const done = { ...meta, gitDir: found[0], commonDir };
  writeMeta(root, done);
  return done;
}

function describeWorkspace(project: ResolvedProject, root: string, agent: string, meta: WorkspaceMeta): AgentWorkspace {
  const top = toplevel(project.dir);
  const full = completeLegacyMeta(top, root, meta);
  // `top` is a real path (git resolves symlinks, e.g. /var -> /private/var on macOS), so compare against the real project dir.
  const rel = path.relative(top, fs.realpathSync(project.dir));
  return {
    agent,
    root,
    dir: rel ? path.join(root, rel) : root,
    gitDir: full.gitDir as string,
    commonDir: full.commonDir as string,
    ...(full.worktreeConfig ? { worktreeConfig: full.worktreeConfig } : {}),
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
    const ws = describeWorkspace(project, root, agent, meta);
    if (ws.base !== newBase) {
      assertNoNestedRepos(ws);
      const untouched = agentGit(ws, ["status", "--porcelain", "--untracked-files=all"]) === "" && agentGit(ws, ["rev-parse", "HEAD"]) === ws.base;
      if (untouched) {
        agentGit(ws, ["reset", "-q", "--hard", newBase]);
        writeMeta(root, metaOf({ ...ws, base: newBase }));
        return { ...ws, base: newBase };
      }
    }
    return ws;
  }

  const branch = `agent-lyceum/${runId}/${agent}`;
  fs.mkdirSync(path.dirname(root), { recursive: true });
  // The new worktree's git dir is the admin dir `worktree add` creates: the one under <commonDir>/worktrees/ that was not there
  // before and whose `gitdir` names this root. Only the user's repo and what git just wrote are read — no agent has run in it yet,
  // and another dispatcher adding a worktree at the same moment cannot be mistaken for it.
  const commonDir = commonDirOf(top);
  const adminDir = path.join(commonDir, "worktrees");
  const before = new Set(fs.existsSync(adminDir) ? fs.readdirSync(adminDir) : []);
  git(top, ["worktree", "add", "-q", "-B", branch, root, newBase]);
  const created = adminDirsNaming(commonDir, root, fs.readdirSync(adminDir).filter((n) => !before.has(n)));
  if (created.length !== 1) throw new Error(`git worktree add made ${root}, but ${created.length} new git dirs under ${adminDir} name it; refusing to guess which is its own.`);
  const gitDir = created[0] as string;
  const worktreeConfig = fingerprint(path.join(gitDir, "config.worktree"));
  meta = { branch, base: newBase, gitDir, commonDir, ...(worktreeConfig ? { worktreeConfig } : {}) };
  writeMeta(root, meta);
  return describeWorkspace(project, root, agent, meta);
}

const metaOf = (ws: AgentWorkspace): WorkspaceMeta => ({
  branch: ws.branch,
  base: ws.base,
  gitDir: ws.gitDir,
  commonDir: ws.commonDir,
  ...(ws.worktreeConfig ? { worktreeConfig: ws.worktreeConfig } : {}),
});

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

/** Commit whatever is in an agent's worktree (no hooks, no signing, dispatcher identity). Returns the HEAD afterwards and whether a commit was made. */
export function commitWorkspace(ws: AgentWorkspace, message: string): { head: string; committed: boolean } {
  assertNoNestedRepos(ws);
  agentGit(ws, ["add", "-A"]);
  let committed = false;
  if (tryAgentGit(ws, ["diff", "--cached", "--quiet"]) === undefined) {
    // agentGit already switches hooks and signing off; --no-verify says so here too
    agentGit(ws, ["commit", "-q", "--no-verify", "-m", message], IDENTITY);
    committed = true;
  }
  return { head: agentGit(ws, ["rev-parse", "HEAD"]), committed };
}

/**
 * Commit whatever the agent left in its worktree and list what changed since its snapshot, checking every
 * changed path (modified, added, deleted, or either end of a rename) against the agent's `owns`, the project
 * folder, the protected instruction files, and symlink/submodule rules. Nothing is applied here.
 */
export function collectAgentChanges(workspace: AgentWorkspace, owns: string[]): ChangeSet {
  const { head } = commitWorkspace(workspace, `agent-lyceum: changes by ${workspace.agent}`);
  const base = workspace.base;
  const raw = base === head ? "" : agentGit(workspace, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", base, head]);
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
      const target = agentGit(workspace, ["show", `${head}:${f.path}`]);
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

function blobAt(at: GitAt, commit: string, file: string): string {
  return tryGitAt(at, ["rev-parse", "--verify", "-q", `${commit}:${file}`]) ?? "absent";
}

/** Git's blob id of what is in the working tree at `file`, or "absent". */
function workingBlob(at: GitAt, file: string): string {
  const abs = path.join(workTreeOf(at), file);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return "absent";
  }
  if (st.isDirectory()) return "directory";
  const input = st.isSymbolicLink() ? fs.readlinkSync(abs) : fs.readFileSync(abs);
  return gitAt(at, ["hash-object", "--stdin"], {}, input).trim();
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

/** A member's changes that could not even be collected (e.g. its worktree was refused): reported like any blocked integration, with nothing applied. */
export function refusedIntegration(project: ResolvedProject, workspace: AgentWorkspace, reason: string): IntegrationResult {
  const changes: ChangeSet = { workspace, base: workspace.base, head: workspace.base, files: [], violations: [] };
  return { status: "blocked", reason, branch: workspace.branch, workspace: workspace.root, ...writeBlockedReport(project, changes, reason, "") };
}

function advanceBase(workspace: AgentWorkspace, newBase: string): void {
  writeMeta(workspace.root, metaOf({ ...workspace, base: newBase }));
}

/**
 * Bring an agent's collected changes into the main working tree (not the index, not HEAD), all or nothing.
 * Blocked, with nothing applied and the agent's work kept, when the changes break the rules, when a file
 * changed in the repo since the agent's snapshot, or when git cannot apply the patch. Repeating a call whose
 * changes are already in place is harmless.
 * `target`: the checkout to bring the changes into — the lead's worktree in a concurrent run; by default your repo's working tree.
 */
export function integrateAgentChanges(project: ResolvedProject, changes: ChangeSet, target?: AgentWorkspace): IntegrationResult {
  const at: GitAt = target ? { ws: target } : { top: toplevel(project.dir) };
  if (target) assertNoNestedRepos(target); // `apply` does not walk the tree, but a tampered lead worktree is not written to either
  const { workspace, base, head } = changes;
  const fullPatch = (paths: string[]): string =>
    paths.length === 0 ? "" : gitAt(at, ["--literal-pathspecs", "diff", "--binary", "--full-index", base, head, "--", ...paths]) + "\n";
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
    const work = workingBlob(at, f.path);
    if (work === blobAt(at, head, f.path)) continue; // already in place
    if (work === blobAt(at, base, f.path)) pending.push(f);
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
      gitAt(at, ["apply", "--binary", "--whitespace=nowarn", "-"], {}, patch);
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      return block(`git could not apply the patch, so none of the changes were applied: ${(err.stderr || err.message).trim()}`);
    }
  }
  advanceBase(workspace, head);
  return { status: "integrated", files: changes.files, applied: pending.length };
}

/**
 * An agent's existing worktree for this run, if it has one (no worktree or no metadata: undefined).
 * Throws when the metadata predates recording the git dir and the git dir cannot be told for certain.
 */
export function existingAgentWorkspace(project: ResolvedProject, runId: string, agent: string): AgentWorkspace | undefined {
  const root = workspaceRoot(project, runId, agent);
  let meta: WorkspaceMeta;
  try {
    meta = JSON.parse(fs.readFileSync(`${root}.json`, "utf8")) as WorkspaceMeta;
  } catch {
    return undefined;
  }
  return fs.existsSync(root) ? describeWorkspace(project, root, agent, meta) : undefined;
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
export function inspectWorkspace(project: ResolvedProject, runId: string, agent: string, target?: AgentWorkspace): WorkspaceWork | undefined {
  const root = workspaceRoot(project, runId, agent);
  if (!fs.existsSync(root)) return undefined;
  let ws: AgentWorkspace | undefined;
  let wsError: string | undefined;
  try {
    ws = existingAgentWorkspace(project, runId, agent);
  } catch (e) {
    wsError = (e as Error).message.split("\n")[0];
  }
  let branch = `agent-lyceum/${runId}/${agent}`;
  try {
    branch = ws?.branch ?? (JSON.parse(fs.readFileSync(`${root}.json`, "utf8")) as WorkspaceMeta).branch ?? branch;
  } catch {
    /* no metadata */
  }
  const work: WorkspaceWork = { agent, root, branch, dirty: [], unintegrated: [] };
  if (wsError) return { ...work, unknown: `its git dir cannot be determined (${wsError})` };
  if (!ws) return { ...work, unknown: "its metadata is missing, so what it holds cannot be compared with the repo" };
  try {
    assertNoNestedRepos(ws);
    work.dirty = parseStatus(agentGit(ws, ["status", "--porcelain", "-z", "--untracked-files=all"]));
    const at: GitAt = target ? { ws: target } : { top: toplevel(project.dir) };
    const head = agentGit(ws, ["rev-parse", "HEAD"]);
    if (head !== ws.base && tryGitAt(at, ["merge-base", "--is-ancestor", head, "HEAD"]) === undefined) {
      const raw = agentGit(ws, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", ws.base, head]);
      const parts = raw.split("\0").filter(Boolean);
      for (let i = 1; i < parts.length; i += 2) {
        const file = parts[i] ?? "";
        if (workingBlob(at, file) !== blobAt(at, head, file)) work.unintegrated.push(file);
      }
    }
  } catch (e) {
    work.unknown = `its state could not be read (${(e as Error).message.split("\n")[0]})`;
  }
  return work;
}

export interface ResultBranch {
  branch: string;
  head: string;
  /** The snapshot the run started from. */
  base: string;
  /** Files the branch changes relative to `base`. */
  files: number;
  /** The same changes as a patch file (absent when nothing changed). */
  patch?: string;
}

/** Commit the lead's checkout on its branch (once, at the end of a run) and write what changed as a patch. Never touches your repo's working tree. */
export function finishLeadBranch(ws: AgentWorkspace, message: string, patchFile: string): ResultBranch {
  const { head } = commitWorkspace(ws, message);
  const files = head === ws.base ? [] : agentGit(ws, ["diff", "--name-only", ws.base, head]).split("\n").filter(Boolean);
  if (files.length) fs.writeFileSync(patchFile, agentGit(ws, ["diff", "--binary", "--full-index", ws.base, head]) + "\n");
  return { branch: ws.branch, head, base: ws.base, files: files.length, patch: files.length ? patchFile : undefined };
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

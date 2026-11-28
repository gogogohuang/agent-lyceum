import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedProject } from "./config.js";
import { atomicWrite } from "./fs-util.js";
import { escapesParent } from "./paths.js";
import { killTree, register, unregister } from "./process-runner.js";
import type { RunState } from "./run-store.js";

export type WorkspaceMode = "shared" | "worktree";

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
export const PINNED_CONFIG = [
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

/** True when the worktree has any uncommitted or untracked path. Uses pinned git, never `dirtyPaths`. */
export function workspaceDirty(ws: AgentWorkspace): boolean {
  assertNoNestedRepos(ws);
  return agentGit(ws, ["status", "--porcelain", "-z", "--untracked-files=all"]) !== "";
}

/** Put the worktree back at `head` (the sha recorded on the claim) and drop untracked files. Never call this on `project.dir`. */
export function discardWorkspaceEdits(ws: AgentWorkspace, head: string): void {
  assertNoNestedRepos(ws);
  agentGit(ws, ["reset", "--hard", head]);
  agentGit(ws, ["clean", "-fd"]);
}

/** HEAD and dirty paths of the user's checkout, before a read-only wake that has no worktree. Undefined when `dir` is not a git repo. */
export function snapshotCheckout(dir: string): { head: string; dirty: string[] } | undefined {
  if (!isGitRepo(dir)) return undefined;
  const head = tryGit(dir, ["rev-parse", "HEAD"]);
  if (!head) return undefined;
  return { head, dirty: dirtyPaths(dir) };
}

/**
 * What changed in a checkout that has no worktree of its own since `snap`. Does not change the checkout:
 * a borrowed folder is shared with the user, so a new path or a moved HEAD is only reported.
 * A path that was already dirty is not listed again.
 */
export function borrowedEdits(dir: string, snap: { head: string; dirty: string[] }): { headMoved: boolean; paths: string[] } {
  if (!isGitRepo(dir)) return { headMoved: false, paths: [] };
  const before = new Set(snap.dirty);
  const headNow = tryGit(dir, ["rev-parse", "HEAD"]);
  return { headMoved: Boolean(headNow && headNow !== snap.head), paths: dirtyPaths(dir).filter((p) => !before.has(p)) };
}

/** Dirty paths in an agent worktree, using pinned git. */
export function workspaceStatusPaths(ws: AgentWorkspace): string[] {
  assertNoNestedRepos(ws);
  return parseStatus(agentGit(ws, ["status", "--porcelain", "-z", "--untracked-files=all"]));
}

/**
 * Undo a read-only wake in an agent worktree. Earlier dirty paths stay, and the tree is not `reset --hard`
 * or cleaned wholesale. Returns the paths that were put back. Never call this on `project.dir`.
 */
export function restoreWorkspaceEdits(ws: AgentWorkspace, snap: { head: string; dirty: string[] }): string[] {
  assertNoNestedRepos(ws);
  const before = new Set(snap.dirty);
  const headNow = agentGit(ws, ["rev-parse", "HEAD"]);
  if (headNow !== snap.head) agentGit(ws, ["reset", "--mixed", snap.head]);
  const touched = parseStatus(agentGit(ws, ["status", "--porcelain", "-z", "--untracked-files=all"])).filter((p) => !before.has(p));
  return restoreTouched(touched, {
    lsFiles: () => agentGit(ws, ["ls-files", "-z"]),
    checkout: (paths) => agentGit(ws, ["checkout", "--", ...paths]),
    clean: (paths) => agentGit(ws, ["clean", "-fd", "--", ...paths]),
  });
}

function restoreTouched(touched: string[], git: { lsFiles: () => string; checkout: (paths: string[]) => void; clean: (paths: string[]) => void }): string[] {
  if (!touched.length) return [];
  const tracked = new Set(zList(git.lsFiles()));
  const restore = touched.filter((p) => tracked.has(p));
  const extra = touched.filter((p) => !tracked.has(p));
  if (restore.length) git.checkout(restore);
  if (extra.length) git.clean(extra);
  return touched;
}

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

/** Why `dir` cannot give every run and agent its own git worktree, or undefined when it can. */
export function isolationBlocker(dir: string): string | undefined {
  if (!isGitRepo(dir)) return "not a git repository";
  if (tryGit(dir, ["rev-parse", "--verify", "-q", "HEAD"]) === undefined) return "no commit yet";
  // With git's reftable ref storage a linked worktree's HEAD lives in `<gitDir>/reftable/`, a place the agent can write, and the
  // file `<gitDir>/HEAD` only says `ref: refs/heads/.invalid`: the check that a worktree's HEAD is its own branch cannot hold
  // there, so every worktree would be refused in the middle of the run. (`rev-parse --show-ref-format` does not exist in older
  // git, which only knows `files`.)
  if (tryGit(dir, ["rev-parse", "--show-ref-format"]) === "reftable") return "reftable ref storage";
  return undefined;
}

/** The result of one git call made through a `GitRunner`: never thrown, a failure or a timeout is `ok: false`. */
export interface GitRunResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
}

/** Runs `git <args>` in `cwd` with `env` added to the process environment. Used for `fetch`, the only call that can wait on the network. */
export type GitRunner = (cwd: string, args: string[], env: NodeJS.ProcessEnv) => GitRunResult;

/** How long a `git fetch` may take before it counts as failed. */
const FETCH_TIMEOUT_MS = 60_000;

const defaultGitRunner: GitRunner = (cwd, args, env) => {
  const r = spawnSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: FETCH_TIMEOUT_MS, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0) return { ok: false };
  return { ok: true, stdout: r.stdout.replace(/\n$/, "") };
};

/**
 * What `git fetch` must never do here: ask a person for a password or a host-key answer.
 * The ssh command is the user's own (`GIT_SSH_COMMAND`, else the repo's `core.sshCommand`, else `ssh`) with `-o BatchMode=yes` added;
 * a config that cannot be read counts as none.
 */
function noPromptEnv(dir: string): NodeJS.ProcessEnv {
  const ssh = process.env.GIT_SSH_COMMAND || tryGit(dir, ["config", "--get", "core.sshCommand"]) || "ssh";
  return { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes` };
}

export interface RemoteBase {
  /** `origin/main` and the like. */
  ref: string;
  sha: string;
  originUrl?: string;
}

const REMOTE_BASE_FALLBACKS = ["origin/main", "origin/master"];

/**
 * The commit new runs should start from: `origin/HEAD`, else `origin/main`, else `origin/master`.
 * Fetches `origin` first when there is one; a fetch that fails or times out is not an error, the remote refs already in the repo are used.
 * `onFetchFailed` is called when that fetch failed, so the caller can say so.
 */
export function resolveRemoteBase(dir: string, run: GitRunner = defaultGitRunner, onFetchFailed?: () => void): RemoteBase | undefined {
  const originUrl = tryGit(dir, ["remote", "get-url", "--push", "origin"]);
  if (originUrl !== undefined && !run(dir, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "origin"], noPromptEnv(dir)).ok) onFetchFailed?.();
  const head = tryGit(dir, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  const candidates = [...(head?.startsWith("refs/remotes/") ? [head.slice("refs/remotes/".length)] : []), ...REMOTE_BASE_FALLBACKS];
  for (const ref of candidates) {
    const sha = tryGit(dir, ["rev-parse", "--verify", "-q", `refs/remotes/${ref}^{commit}`]);
    if (sha) return { ref, sha, ...(originUrl ? { originUrl } : {}) };
  }
  return undefined;
}

export interface WorkspacePlan {
  mode: WorkspaceMode;
  /** The lead works in its own worktree (isolation mode); otherwise it works in the checkout. */
  leadWorktree: boolean;
  /** Set on resume of a run that works in the project checkout on its own branch: the branch its state recorded. */
  taskBranch?: string;
  /** The remote ref (`origin/main`) and the commit it pointed at when the plan was made. */
  baseRef?: string;
  baseSha?: string;
  originUrl?: string;
  /** Set with `taskBranch` on a new run: the branch (or commit, when detached) the checkout was on before the task branch was cut. */
  checkoutFrom?: string;
  /** Why the run works in the checkout, or why the lead is not in the project checkout, when it was probed. */
  reason?: string;
  /** `git fetch origin` failed or timed out while planning; the remote refs already in the repo were used. */
  fetchFailed?: boolean;
  /** Why a run that meant to borrow the project checkout was moved to its own worktree when the lock was taken (busy, or no longer fit). */
  lockFallback?: string;
}

export interface PlanOptions {
  /** Test seam: replaces the runner that fetches `origin`. */
  fetch?: GitRunner;
  /** The caller found the project checkout taken by another run; the plan then keeps the lead out of it. */
  checkoutHeldByOther?: boolean;
}

/** Why the project checkout cannot be lent to a new run sitting at `base`, or undefined when it can. */
function checkoutBlocker(dir: string, base: RemoteBase, heldByOther: boolean): string | undefined {
  if (heldByOther) return "the project checkout is in use by another run";
  if (dirtyPaths(dir).length > 0) return "the project checkout has uncommitted changes";
  if (tryGit(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]) !== base.sha) return `the project checkout is not at ${base.ref}`;
  const branch = tryGit(dir, ["symbolic-ref", "-q", "HEAD"]);
  if (branch?.startsWith("refs/heads/agent-lyceum/")) return `the project checkout is on ${branch.slice("refs/heads/".length)}`;
  return undefined;
}

/** The plan a run falls back to when it cannot borrow the project checkout: the lead in its own worktree, no task branch; the remote base stays. */
export function toLeadWorktree(plan: WorkspacePlan): WorkspacePlan {
  const { taskBranch: _taskBranch, checkoutFrom: _checkoutFrom, ...rest } = plan;
  return { ...rest, leadWorktree: true };
}

/** Does this (new run's) plan intend to borrow the project checkout? */
export const borrowsCheckout = (plan: WorkspacePlan): boolean => plan.leadWorktree === false && plan.baseSha !== undefined;

/** Why the checkout cannot be borrowed now (dirty, moved off `plan.baseSha`, on an `agent-lyceum/*` branch), or undefined when it still can. Takes no lock. */
export function checkoutBlockedNow(dir: string, plan: WorkspacePlan): string | undefined {
  if (plan.baseSha === undefined) return "no remote base";
  return checkoutBlocker(dir, { ref: plan.baseRef ?? plan.baseSha, sha: plan.baseSha }, false);
}

/** Where HEAD is: `ref:refs/heads/x` on a branch, the commit when detached, undefined in a repo without a commit. Never reads the exit code of a git command that moved it. */
const headPlace = (dir: string): string | undefined => {
  const ref = tryGit(dir, ["symbolic-ref", "-q", "HEAD"]);
  if (ref !== undefined) return `ref:${ref}`;
  return tryGit(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
};

/** The checkout's current branch name, or its commit when HEAD is detached: what a failed start returns to. */
export function currentCheckoutRef(dir: string): string | undefined {
  return tryGit(dir, ["symbolic-ref", "-q", "--short", "HEAD"]) ?? tryGit(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
}

const branchTip = (dir: string, branch: string): string | undefined => tryGit(dir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`]);

/**
 * Cut `branch` at `sha` and switch the checkout to it (`git checkout -b`, never `-B`: an existing branch is an error and is not reset).
 * The repository's hooks run. Whether it worked is judged by where HEAD is before and after, not by git's exit code: a failing
 * `post-checkout` hook still leaves HEAD on the new branch (`moved: true`), a hook that stops the switch leaves it where it was (`moved: false`).
 */
export function checkoutLeadBranch(dir: string, branch: string, sha: string): { moved: boolean } {
  if (branchTip(dir, branch) !== undefined) throw new Error(`The branch ${branch} already exists in ${dir}; it was not touched.`);
  const before = headPlace(dir);
  const r = spawnSync("git", ["checkout", "-q", "-b", branch, sha], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const moved = headPlace(dir) !== before;
  if (!moved && r.stderr) process.stderr.write(r.stderr);
  return { moved };
}

/** Where a failed start put the checkout back to: the recorded `checkout_from` still resolves (a local branch, or a commit when it was detached). */
function checkoutFromExists(dir: string, from: string): boolean {
  return branchTip(dir, from) !== undefined || (/^[0-9a-f]{40}$/.test(from) && tryGit(dir, ["rev-parse", "--verify", "-q", `${from}^{commit}`]) === from);
}

/** Is the checkout on `from` now (the branch, or the detached commit)? */
function checkoutIsAt(dir: string, from: string): boolean {
  const here = headPlace(dir);
  return here === `ref:refs/heads/${from}` || (/^[0-9a-f]{40}$/.test(from) && here === from);
}

const removeRunDir = (runDir: string): void => fs.rmSync(runDir, { recursive: true, force: true });

/**
 * A new checkout run whose state is written but whose task is not yet in the lead's inbox, taken back: the checkout returns to
 * `checkout_from`, the task branch (when it is still at `base_sha`) and the whole run dir are removed. Call it with the run's lock held.
 * It only ever changes what this start changed: a branch with commits of its own, a tree with uncommitted changes, or a `checkout_from`
 * that is gone make it throw and leave the state, the branch and HEAD alone (it never tries a second switch).
 */
export function rollbackCheckoutStart(dir: string, runDir: string, state: RunState): void {
  const branch = state.task_branch;
  const tip = branch ? branchTip(dir, branch) : undefined;
  if (branch === undefined || tip === undefined) {
    removeRunDir(runDir); // the branch was never cut; HEAD never moved
    return;
  }
  if (tip !== state.base_sha) {
    throw new Error(`The branch ${branch} has commits of its own (it is at ${tip.slice(0, 8)}, not at the base ${state.base_sha?.slice(0, 8) ?? "that was not recorded"}); nothing was removed. Run ${state.run_id} is kept as it is.`);
  }
  const ref = `refs/heads/${branch}`;
  if (headPlace(dir) === `ref:${ref}`) {
    const from = state.checkout_from;
    if (dirtyPaths(dir).length > 0) throw new Error(`The project checkout is on ${branch} and has uncommitted changes, so it was not switched back${from ? ` to ${from}` : ""}; nothing was removed. Run ${state.run_id} is kept as it is.`);
    if (from === undefined || !checkoutFromExists(dir, from)) {
      throw new Error(`The project checkout is on ${branch}, and the branch it was cut from (${from ?? "not recorded"}) is not there to go back to. Switch it yourself; nothing was removed. Run ${state.run_id} is kept as it is.`);
    }
    spawnSync("git", ["checkout", "-q", "--no-guess", from, "--"], { cwd: dir, stdio: "ignore" }); // once; hooks may fail it after it moved
    if (!checkoutIsAt(dir, from)) {
      throw new Error(`The project checkout could not be switched from ${branch} back to ${from}; it stays on ${branch}. Nothing was removed. Run ${state.run_id} is kept as it is.`);
    }
  }
  // Only the exact commit this start cut it at: the update fails when the branch moved meanwhile.
  git(dir, ["update-ref", "-d", ref, tip]);
  removeRunDir(runDir);
}

/** The first thing a new checkout run does once its state is saved (without `task_sent`): cut the task branch. On any failure the run dir is gone. */
export function beginCheckoutRun(dir: string, runDir: string, state: RunState): void {
  const { task_branch: branch, base_sha: sha } = state;
  if (!branch || !sha) {
    removeRunDir(runDir);
    throw new Error(`Run ${state.run_id} has no task branch or base commit to check out.`);
  }
  let moved: boolean;
  try {
    ({ moved } = checkoutLeadBranch(dir, branch, sha));
  } catch (e) {
    removeRunDir(runDir);
    throw e;
  }
  if (!moved) {
    removeRunDir(runDir);
    throw new Error(`git could not switch the project checkout to ${branch} (HEAD did not move), so run ${state.run_id} was not started.`);
  }
}

/**
 * Under the run's lock, before a checkout run goes on. Its task never reached the lead (`task_sent` missing): the start is taken back
 * (see `rollbackCheckoutStart`) and this throws that the run is gone. Its task was sent: the checkout must still be on the task branch;
 * it is never switched for you, and the run is not turned into a worktree run.
 */
export function assertCheckoutResumable(dir: string, runDir: string, state: RunState): void {
  if (state.task_sent !== true) {
    rollbackCheckoutStart(dir, runDir, state);
    throw new Error(`Run ${state.run_id} never got its task to ${state.task_branch ? `the lead on ${state.task_branch}` : "the lead"}; the start was taken back (the project checkout is as it was, the run's folder is removed). Start it again with \`run\`.`);
  }
  const branch = state.task_branch;
  if (!branch) throw new Error(`Run ${state.run_id} works in the project checkout, but its state does not record a task_branch.`);
  if (headPlace(dir) !== `ref:refs/heads/${branch}`) {
    const here = tryGit(dir, ["symbolic-ref", "-q", "--short", "HEAD"]) ?? "a detached HEAD";
    throw new Error(`Run ${state.run_id} works on the branch ${branch}, but the project checkout is on ${here}. Switch to ${branch} (git checkout ${branch}) and resume again; it was not switched for you.`);
  }
}

/** Whether the repo knows an `origin` at all: a remote, or refs fetched from one. */
const hasOrigin = (dir: string): boolean =>
  tryGit(dir, ["remote", "get-url", "origin"]) !== undefined || (tryGit(dir, ["for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes/origin/"]) ?? "") !== "";

/**
 * Where a run's agents work. A new run is isolated when the project dir can be (see `isolationBlocker`), otherwise it shares the
 * checkout. When the repo has a remote base and the project checkout is clean, sits exactly on it and nobody else holds it, the lead
 * borrows the checkout (`leadWorktree: false`, with `baseSha`); otherwise the lead gets its own worktree. A resumed run keeps what its
 * state recorded, whatever the repo looks like now. Decided once, before the run's lock is taken; it takes no lock itself.
 */
export function planWorkspace(project: ResolvedProject, resume?: RunState, opts: PlanOptions = {}): WorkspacePlan {
  if (resume) {
    if (resume.lead_workspace === true) return { mode: "worktree", leadWorktree: true };
    if (resume.workspace_mode === "checkout") return { mode: "worktree", leadWorktree: false, ...(resume.task_branch ? { taskBranch: resume.task_branch } : {}) };
    if (resume.workspace_mode === "worktree") return { mode: "worktree", leadWorktree: false };
    return { mode: "shared", leadWorktree: false };
  }
  const blocker = isolationBlocker(project.dir);
  if (blocker !== undefined) return { mode: "shared", leadWorktree: false, reason: blocker };
  let fetchFailed = false;
  const base = resolveRemoteBase(project.dir, opts.fetch, () => (fetchFailed = true));
  const failed = fetchFailed ? { fetchFailed: true } : {};
  if (!base) {
    return hasOrigin(project.dir)
      ? { mode: "worktree", leadWorktree: true, ...failed, reason: "no remote base: origin/HEAD, origin/main and origin/master are all missing" }
      : { mode: "worktree", leadWorktree: true };
  }
  const remote = { baseRef: base.ref, baseSha: base.sha, ...(base.originUrl ? { originUrl: base.originUrl } : {}), ...failed };
  const reason = checkoutBlocker(project.dir, base, opts.checkoutHeldByOther === true);
  return reason === undefined ? { mode: "worktree", leadWorktree: false, ...remote } : { mode: "worktree", leadWorktree: true, ...remote, reason };
}

/** Refuse to resume a worktree run when its repo can no longer be isolated; returns nothing when it is fine. */
export function assertWorktreeRunnable(project: ResolvedProject): void {
  if (!isGitRepo(project.dir)) {
    throw new Error(`This run works in git worktrees, but ${project.dir} is no longer a git repository.`);
  }
  if (tryGit(project.dir, ["rev-parse", "--show-ref-format"]) === "reftable") {
    throw new Error(`This run works in git worktrees, but ${project.dir} now uses git's reftable ref storage, whose worktrees agent-lyceum cannot yet verify as isolated.`);
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

/** `refs/agent-lyceum/<run>/base-0` pointing at `sha` (a remote base the run records): where a concurrent run with a remote base starts, whatever the local HEAD is. */
export function snapshotCommit(project: ResolvedProject, runId: string, sha: string): string {
  const top = toplevel(project.dir);
  const commit = git(top, ["rev-parse", "--verify", `${sha}^{commit}`]);
  const ref = `refs/agent-lyceum/${runId}/base-0`;
  git(top, ["update-ref", ref, commit]);
  return ref;
}

/**
 * What to tell the user when a new run starts from the remote base `sha` while the local HEAD is somewhere else: on another task's
 * `agent-lyceum/*` branch the run is moved into a worktree; otherwise your local checkout has not reached that commit.
 * Undefined when HEAD is at `sha` (or the repo has no HEAD).
 */
export function remoteBaseNote(project: ResolvedProject, sha: string, baseRef?: string): string | undefined {
  const dir = project.dir;
  const head = tryGit(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (head === undefined || head === sha) return undefined;
  const branch = tryGit(dir, ["symbolic-ref", "-q", "HEAD"]);
  if (branch?.startsWith("refs/heads/agent-lyceum/")) {
    return `這次 run 改在 worktree：你的 checkout 在 ${branch.slice("refs/heads/".length)}，不在 ${baseRef ?? "遠端基準"} ${sha.slice(0, 8)}`;
  }
  return `本地尚未進入這顆 commit（${baseRef ?? "遠端基準"} ${sha.slice(0, 8)}）：這次 run 從它開始，不含你本地 HEAD ${head.slice(0, 8)} 上的提交`;
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

/**
 * The git tree of the working tree as it is now (tracked changes and new, non-ignored files), through a throwaway index:
 * nothing of the repo is touched. A worktree is read with the pinned git (no hooks, fsmonitor, filters from the worktree).
 * Undefined when `dir` is not a git repository or the tree cannot be read (a nested repository in a worktree, ...).
 */
export async function workingTreeHash(project: ResolvedProject, from?: AgentWorkspace, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string | undefined> {
  const index = path.join(os.tmpdir(), `agent-lyceum-index-${crypto.randomBytes(6).toString("hex")}`);
  const deadline = Date.now() + (opts.timeoutMs ?? HASH_BUDGET_MS);
  // No hooks (git runs post-index-change after writing an index, also a temporary one) and no fsmonitor, in both modes.
  // Clean filters named in the repo's own config still run during `add -A` (as in snapshotBase); only the deadline bounds them.
  const run = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> =>
    boundedGit(cwd, from ? pinnedArgs(args) : ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], from ? pinnedEnv(from, env) : env, deadline, opts.signal);
  try {
    let cwd: string;
    if (from) {
      assertWorkspaceIntact(from);
      assertNoNestedRepos(from); // sync, no hooks, quick
      cwd = from.root;
    } else cwd = await run(project.dir, ["rev-parse", "--show-toplevel"]);
    const env = { GIT_INDEX_FILE: index };
    const head = await run(cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined);
    if (head) await run(cwd, ["read-tree", head], env);
    await run(cwd, ["add", "-A"], env);
    return await run(cwd, ["write-tree"], env);
  } catch {
    return undefined;
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.lock`, { force: true }); // a git killed during `add` leaves its lock behind
  }
}

/** The most the tree hash may take in total (spec 27.7 record, spec 28 comparison); then it is absent and verification goes on. */
const HASH_BUDGET_MS = 30_000;

/** git in its own process group, killed with SIGKILL (group and descendants) at `deadline` or on `signal`; the event loop stays free meanwhile. */
function boundedGit(cwd: string, args: string[], env: NodeJS.ProcessEnv, deadline: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const child = spawn("git", args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    if (child.pid !== undefined) register(child.pid);
    let out = "";
    let err = "";
    let done = false;
    const end = (e?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (child.pid !== undefined) {
        killTree(child.pid, "SIGKILL"); // also what a filter left behind
        unregister(child.pid);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (e) reject(e);
      else resolve(out.replace(/\n$/, ""));
    };
    const onAbort = () => end(new Error("aborted"));
    const timer = setTimeout(() => end(new Error("timed out")), Math.max(0, deadline - Date.now()));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString("utf8").slice(0, 4096);
    });
    child.on("error", (e) => end(e));
    child.on("close", (code) => end(code === 0 ? undefined : new Error(`git ${args.join(" ")} failed: ${err.trim()}`)));
  });
}

interface WorkspaceMeta {
  branch: string;
  base: string;
  /** Recorded when the worktree is made (absent in meta written by older versions). */
  gitDir?: string;
  commonDir?: string;
  worktreeConfig?: string;
}

export const workspaceRoot = (project: ResolvedProject, runId: string, agent: string): string => path.join(project.paths.root, "worktrees", runId, agent);

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
 * changed path (modified, added, deleted, or either end of a rename) against the project
 * folder, the protected instruction files, and symlink/submodule rules. Nothing is applied here.
 */
export function collectAgentChanges(workspace: AgentWorkspace, message?: string): ChangeSet {
  const { head } = commitWorkspace(workspace, (typeof message === "string" && message ? message : `agent-lyceum: changes by ${workspace.agent}`));
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
    if (f.mode === "160000") violations.push(`${f.path}: submodule changes are not integrated`);
    if (f.mode === "120000" && f.status !== "D") {
      const target = agentGit(workspace, ["show", `${head}:${f.path}`]);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(p), target));
      if (path.posix.isAbsolute(target)) violations.push(`${f.path}: symlink to an absolute path (${target})`);
      else if (escapesParent(resolved, "/")) violations.push(`${f.path}: symlink leaves the project directory (${target})`);
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

/**
 * The git dir recorded in an agent's worktree metadata, read-only (never completes or rewrites legacy metadata). undefined when there
 * is no readable metadata or it predates recording the git dir.
 */
export function recordedGitDir(project: ResolvedProject, runId: string, agent: string): string | undefined {
  try {
    const meta = JSON.parse(fs.readFileSync(`${workspaceRoot(project, runId, agent)}.json`, "utf8")) as WorkspaceMeta;
    return typeof meta.gitDir === "string" && meta.gitDir ? meta.gitDir : undefined;
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

/**
 * What is in an agent's worktree that exists nowhere else: uncommitted changes, and commits whose files are not in the main repo.
 * `target`: where the commits are looked for. A worktree (the lead's, in a concurrent run), a commit of your repo (`{ commit }`: a checkout
 * run's recorded result, compared as it was committed, whatever your HEAD is now), or by default your repo's working tree.
 */
export function inspectWorkspace(project: ResolvedProject, runId: string, agent: string, target?: AgentWorkspace | { commit: string }): WorkspaceWork | undefined {
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
    const commit = target && "commit" in target ? target.commit : undefined;
    const at: GitAt = target && !commit ? { ws: target as AgentWorkspace } : { top: toplevel(project.dir) };
    const head = agentGit(ws, ["rev-parse", "HEAD"]);
    if (head !== ws.base && tryGitAt(at, ["merge-base", "--is-ancestor", head, commit ?? "HEAD"]) === undefined) {
      const raw = agentGit(ws, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", ws.base, head]);
      const parts = raw.split("\0").filter(Boolean);
      for (let i = 1; i < parts.length; i += 2) {
        const file = parts[i] ?? "";
        if ((commit ? blobAt(at, commit, file) : workingBlob(at, file)) !== blobAt(at, head, file)) work.unintegrated.push(file);
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
  const { head, committed } = commitWorkspace(ws, message);
  // Member integrations are committed before a team lead wakes, so the tree can already be clean while the branch is ahead of its base. The closing commit still carries the run's message.
  if (!committed && head !== ws.base) agentGit(ws, ["commit", "-q", "--no-verify", "--allow-empty", "-m", message], IDENTITY);
  const tip = agentGit(ws, ["rev-parse", "HEAD"]);
  const files = tip === ws.base ? [] : agentGit(ws, ["diff", "--name-only", ws.base, tip]).split("\n").filter(Boolean);
  if (files.length) fs.writeFileSync(patchFile, agentGit(ws, ["diff", "--binary", "--full-index", ws.base, tip]) + "\n");
  return { branch: ws.branch, head: tip, base: ws.base, files: files.length, patch: files.length ? patchFile : undefined };
}

/** What a checkout run's task branch is now, for `clear`: its tip (undefined when the branch is gone), whether HEAD names it, and whether the tip is in HEAD. */
export function taskBranchState(dir: string, branch: string): { tip?: string; headIsBranch: boolean; tipInHead: boolean } {
  const top = toplevel(dir);
  const tip = tryGit(top, ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`]);
  const headIsBranch = tryGit(top, ["symbolic-ref", "-q", "HEAD"]) === `refs/heads/${branch}`;
  const tipInHead = tip !== undefined && tryGit(top, ["merge-base", "--is-ancestor", tip, "HEAD"]) !== undefined;
  return { tip, headIsBranch, tipInHead };
}

/** A commit of your repo by name (a sha), or undefined when it is not there. */
export function resolveCommit(dir: string, sha: string): string | undefined {
  return tryGit(toplevel(dir), ["rev-parse", "--verify", "-q", `${sha}^{commit}`]);
}

/**
 * `git branch -D` of a checkout run's task branch, only while it is still what `clear` planned to delete: HEAD does not name it, its tip
 * is `expectedTip` (nothing was committed on it since the plan) and that tip is in HEAD. Throws, deleting nothing, otherwise.
 */
export function deleteTaskBranch(dir: string, branch: string, expectedTip: string): void {
  const s = taskBranchState(dir, branch);
  if (s.headIsBranch) throw new Error(`the project checkout is on ${branch}; switch to another branch first`);
  if (s.tip === undefined) return; // already gone
  if (s.tip !== expectedTip) throw new Error(`${branch} moved since the plan (now at ${s.tip.slice(0, 8)}); kept it`);
  if (!s.tipInHead) throw new Error(`${branch} is no longer in HEAD; kept it`);
  git(toplevel(dir), ["branch", "-D", "--", branch]);
}

/** Why the project checkout is not on its task branch `branch` (HEAD names another branch, or is detached), or undefined when it is. */
export function checkoutHeadProblem(dir: string, branch: string): string | undefined {
  const head = tryGit(dir, ["symbolic-ref", "-q", "HEAD"]);
  if (head === `refs/heads/${branch}`) return undefined;
  const where = head !== undefined ? head.replace(/^refs\/heads\//, "") : "a detached commit";
  return `The project checkout is no longer on the task branch ${branch} (HEAD is ${where}).`;
}

/** Runs git without a time limit (`add -A` and `commit` in a big checkout may take long), keeping stdout and stderr. */
const checkoutRunner: GitRunner = (cwd, args, env) => {
  const r = spawnSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0) return { ok: false, stderr: (r.stderr || r.error?.message || "").trim() };
  return { ok: true, stdout: r.stdout.replace(/\n$/, "") };
};

/**
 * A checkout run, at its end: commit what is in the project checkout on the task branch `branch`, once, and write what changed since
 * `baseSha` as a patch. Returns undefined, and touches nothing, when HEAD is not `refs/heads/<branch>` (the checkout was moved: a commit
 * would land on the branch HEAD names now). `add -A` and `commit` run with the pinned config (no hooks, no fsmonitor, no signing, `--no-verify`),
 * and a nested git repository in the checkout is refused first, as in an agent's worktree. `run` is a test seam, as for `resolveRemoteBase`.
 */
export function finishCheckoutBranch(dir: string, branch: string, baseSha: string, message: string, patchFile: string, run: GitRunner = checkoutRunner): ResultBranch | undefined {
  if (checkoutHeadProblem(dir, branch) !== undefined) return undefined;
  const pinned = (args: string[], env: NodeJS.ProcessEnv = {}): GitRunResult => run(dir, pinnedArgs(args), env);
  const need = (args: string[], env?: NodeJS.ProcessEnv): string => {
    const r = pinned(args, env);
    if (!r.ok) throw new Error(`git ${args[0]} failed in ${dir}${r.stderr ? `: ${r.stderr.split("\n")[0]}` : ""}`);
    return r.stdout ?? "";
  };
  for (const p of zList(need(["ls-files", "-o", "--exclude-standard", "-z"])).filter((e) => e.endsWith("/"))) {
    throw new Error(`Refusing to run git in ${dir}: it contains a nested git repository at ${p.slice(0, -1)}; remove it, or add it to .gitignore if it must stay. Nothing in it was touched.`);
  }
  need(["add", "-A"]);
  if (!pinned(["diff", "--cached", "--quiet"]).ok) need(["commit", "-q", "--no-verify", "-m", message], IDENTITY);
  const head = need(["rev-parse", "HEAD"]);
  const files = head === baseSha ? [] : need(["diff", "--name-only", baseSha, head]).split("\n").filter(Boolean);
  if (files.length) fs.writeFileSync(patchFile, need(["diff", "--binary", "--full-index", baseSha, head]) + "\n");
  return { branch, head, base: baseSha, files: files.length, patch: files.length ? patchFile : undefined };
}

/**
 * A reopened run whose lead branch was already merged into your HEAD starts its next segment on a fresh branch cut from HEAD,
 * so the merged work is not offered again. Only when nothing would be lost: the branch's last committed head (`resultHead`) is
 * in HEAD, the worktree is still at that head, and it holds no uncommitted work and nothing whose state is unknown.
 * Otherwise the worktree and branch are returned unchanged. Also unchanged while HEAD is on an `agent-lyceum/*` branch (another task's).
 * The new branch is always cut from the local HEAD, never from the run's `base_sha`, which would drop what you merged since.
 * Your working tree, index and HEAD are never touched.
 */
export function recutLeadWorkspace(project: ResolvedProject, runId: string, agent: string, ws: AgentWorkspace, resultHead: string | undefined): { ws: AgentWorkspace; recut: boolean } {
  const keep = { ws, recut: false };
  if (!resultHead) return keep;
  // HEAD is on another task's branch: a branch cut from it would be built on that task's work, not on yours.
  if (tryGit(toplevel(project.dir), ["symbolic-ref", "-q", "HEAD"])?.startsWith("refs/heads/agent-lyceum/")) return keep;
  if (tryGit(toplevel(project.dir), ["merge-base", "--is-ancestor", resultHead, "HEAD"]) === undefined) return keep;
  const work = inspectWorkspace(project, runId, agent, ws);
  if (!work || work.unknown || work.dirty.length) return keep;
  try {
    if (agentGit(ws, ["rev-parse", "HEAD"]) !== resultHead) return keep;
  } catch {
    return keep;
  }
  removeAgentWorkspace(project, runId, agent);
  return { ws: prepareAgentWorkspace(project, runId, agent, snapshotHead(project, runId)), recut: true };
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

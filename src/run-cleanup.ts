import fs from "node:fs";
import path from "node:path";
import type { ResolvedProject } from "./config.js";
import { atomicWrite } from "./fs-util.js";
import { assertName } from "./paths.js";
import { inspectRunLock } from "./project-lock.js";
import { loadRunState, type RunState } from "./run-store.js";
import { runIsAlive } from "./status.js";
import { deleteSnapshotRefs, existingAgentWorkspace, inspectWorkspace, deleteTaskBranch, listSnapshotRefs, listWorkspaceAgents, removeAgentWorkspace, resolveCommit, taskBranchState } from "./worktree.js";
import { must } from "./assert.js";
import type { ResultBranch } from "./worktree.js";

export interface CleanupItem {
  kind: "workspace" | "task-branch" | "refs" | "task-memory" | "run";
  /** One line for people. */
  label: string;
  path?: string;
  agent?: string;
  /** `task-branch`: a checkout run's branch, in the project repo. Only branches that are deleted are items (the ones kept are in `keep`). */
  branch?: string;
  delete?: boolean;
  /** `task-branch`: the tip that was checked at plan time; the branch is deleted only while it is still there. */
  tip?: string;
  reason?: string;
}

export interface CleanupPlan {
  project: ResolvedProject;
  runId: string;
  runDir: string;
  keepWorktrees: boolean;
  /** What will be removed, in this order (the run itself last, so an interrupted clear can be found and repeated). */
  items: CleanupItem[];
  /** Reasons not to clear at all. */
  refusals: string[];
  /** Work that exists only in a worktree: kept, never deleted. */
  keep: { agent: string; branch: string; path: string; files: string[]; /** Set for a checkout run's task branch: why it stays. */ reason?: string }[];
  /** Short description of the run, for messages. */
  summary: string;
}

export interface CleanupReport {
  done: CleanupItem[];
  failed: { item: CleanupItem; error: string }[];
}

const journalDir = (p: ResolvedProject) => path.join(p.paths.root, "cleanup");
const journalFile = (p: ResolvedProject, runId: string) => path.join(journalDir(p), `${runId}.json`);
const lexists = (p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * What clearing a run would do. Deletes nothing. Refuses (see `refusals`) while the run is running, or while
 * a worktree holds work that is not in the repo, unless `keepWorktrees` keeps the worktrees and their branches.
 * `lockHeld`: the caller holds this run's lock (taking it would have thrown while a dispatcher was alive), so the
 * run cannot be running and the lock, which is the caller's own, is not consulted.
 */
export function planRunCleanup(project: ResolvedProject, runId: string, opts: { keepWorktrees?: boolean; lockHeld?: boolean } = {}): CleanupPlan {
  assertName("run", runId);
  const keepWorktrees = !!opts.keepWorktrees;
  const runDir = path.join(project.paths.runs, runId);
  const hasRun = lexists(path.join(runDir, "state.json"));
  const hasJournal = fs.existsSync(journalFile(project, runId));
  if (!hasRun && !hasJournal) throw new Error(`Run "${runId}" not found in ${project.paths.runs}. List ids with: agent-lyceum status --task-list`);

  const plan: CleanupPlan = { project, runId, runDir, keepWorktrees, items: [], refusals: [], keep: [], summary: runId };
  let state: RunState | undefined;
  if (hasRun) {
    state = loadRunState(runDir);
    plan.summary = `${runId}: ${state.task_summary}`;
    if (!state.end_reason && !opts.lockHeld && runIsAlive(state, project)) {
      const holder = state.schema_version >= 2 ? inspectRunLock(project.paths.root, runId) : undefined;
      plan.refusals.push(`Run ${runId} is still running (pid ${holder?.pid ?? state.pid}); stop it first.`);
    }
  }

  // A concurrent run has a worktree for the lead: members' work lands there, and the lead's branch is what you merge.
  const leadWs = existingAgentWorkspace(project, runId, project.lead);
  // A checkout run's lead worked in the project checkout on `task_branch`: members' work is looked for in what the run recorded as its
  // result (else the branch's tip), never in whatever the user has checked out now.
  const taskBranch = state?.workspace_mode === "checkout" && state.task_branch ? state.task_branch : undefined;
  const branchNow = taskBranch ? safeTaskBranchState(project, taskBranch) : undefined;
  const recorded = taskBranch ? state?.result_branch : undefined;
  const against = taskBranch ? ((recorded && safeResolve(project, recorded.head)) ?? branchNow?.state?.tip) : undefined;
  for (const agent of listWorkspaceAgents(project, runId)) {
    const w = inspectWorkspace(project, runId, agent, agent === project.lead ? undefined : against ? { commit: against } : leadWs);
    if (!w) continue;
    const files = [...new Set([...w.dirty, ...w.unintegrated])];
    const holdsWork = files.length > 0 || !!w.unknown;
    if (keepWorktrees || holdsWork) {
      plan.keep.push({ agent, branch: w.branch, path: w.root, files: files.length ? files : w.unknown ? [`(${w.unknown})`] : [] });
      if (holdsWork && !keepWorktrees) {
        const merge = agent === project.lead && leadWs ? ` Merge it first with \`git merge ${w.branch}\`.` : "";
        plan.refusals.push(
          `${agent} has work that is not in the repo: ${files.length ? files.join(", ") : w.unknown} (branch ${w.branch}, worktree ${w.root}).${merge} ` +
            `Bring it in or discard it by hand, or use --keep-worktrees to keep the worktree and branch and clear the rest.`,
        );
      }
      continue;
    }
    plan.items.push({ kind: "workspace", agent, path: w.root, label: `worktree and branch of ${agent} (${w.root}, ${w.branch}): its work is in the repo` });
  }
  if (taskBranch && branchNow) planTaskBranch(plan, taskBranch, branchNow, recorded);
  if (!keepWorktrees && listSnapshotRefs(project, runId).length) {
    plan.items.push({ kind: "refs", label: `snapshot refs refs/agent-lyceum/${runId}/*` });
  }
  const mem = path.join(project.paths.taskMemory, runId);
  if (lexists(mem)) plan.items.push({ kind: "task-memory", path: mem, label: `task memory ${mem}` });
  if (hasRun || lexists(runDir)) plan.items.push({ kind: "run", path: runDir, label: `run directory ${runDir} (state, log, result, snapshots, kept violations, mailboxes)` });
  return plan;
}

function safeTaskBranchState(project: ResolvedProject, branch: string): { state?: ReturnType<typeof taskBranchState>; error?: string } {
  try {
    return { state: taskBranchState(project.dir, branch) };
  } catch (e) {
    return { error: (e as Error).message.split("\n")[0] };
  }
}

function safeResolve(project: ResolvedProject, sha: string): string | undefined {
  try {
    return resolveCommit(project.dir, sha);
  } catch {
    return undefined;
  }
}

/**
 * What happens to a checkout run's task branch. It is deleted only when all hold: a result is recorded, the worktrees are not kept, HEAD does
 * not name the branch, and the branch's tip (not just the recorded `result_branch.head`) is in HEAD. Anything else keeps it and says why.
 * HEAD on the branch refuses the plan: nothing is switched for the user.
 */
function planTaskBranch(plan: CleanupPlan, branch: string, now: { state?: ReturnType<typeof taskBranchState>; error?: string }, recorded: ResultBranch | undefined): void {
  const { project, keepWorktrees } = plan;
  const keep = (reason: string): void => {
    plan.keep.push({ agent: project.lead, branch, path: project.dir, files: [], reason });
  };
  if (!now.state) {
    keep(`its state could not be read (${now.error ?? "unknown"}), so it was not deleted`);
    return;
  }
  const { tip, headIsBranch, tipInHead } = now.state;
  if (headIsBranch) {
    plan.refusals.push(`The project checkout is on the run's task branch ${branch}. Switch to another branch first (it is not switched for you), then clear again.`);
    return;
  }
  if (tip === undefined) return; // gone already
  if (keepWorktrees) {
    keep(`kept by --keep-worktrees${recorded ? "" : "; there is also no recorded result commit"}`);
    return;
  }
  if (!recorded) {
    keep("沒有已記錄的結果 commit (the run recorded no result), so whether its work is in HEAD is not known; it was not deleted");
    return;
  }
  if (!tipInHead) {
    const later = tip !== recorded.head ? `; it has moved on from the recorded result ${recorded.head.slice(0, 8)}` : "";
    keep(`its tip ${tip.slice(0, 8)} is not in HEAD (not merged, or squashed)${later}; it was not deleted`);
    return;
  }
  plan.items.push({ kind: "task-branch", branch, delete: true, tip, label: `task branch ${branch} (its tip ${tip.slice(0, 8)} is in HEAD)` });
}

/** Remove a path without ever following a symlink, and only inside the project home. */
function safeRemove(project: ResolvedProject, target: string): void {
  if (!lexists(target)) return;
  if (fs.lstatSync(target).isSymbolicLink()) {
    fs.unlinkSync(target); // the link, never what it points to
    return;
  }
  const root = fs.realpathSync(project.paths.root);
  const inside = (p: string) => p === root || p.startsWith(root + path.sep);
  if (!inside(fs.realpathSync(path.dirname(target))) || !inside(fs.realpathSync(target))) {
    throw new Error(`refusing to delete ${target}: it is not inside the project home ${project.paths.root}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

export interface ExecuteHooks {
  /** Test seam: called after each item is done and recorded. */
  afterItem?: (item: CleanupItem) => void;
}

/**
 * Carry out a plan, step by step. Progress is written to a journal in the project home (outside the run being
 * deleted), so an interrupted clear can simply be repeated. Stops at the first step that fails, leaving the run
 * directory in place for the retry.
 */
export function executeRunCleanup(plan: CleanupPlan, hooks: ExecuteHooks = {}): CleanupReport {
  if (plan.refusals.length) throw new Error(`Cleanup refused:\n${plan.refusals.map((r) => `- ${r}`).join("\n")}`);
  const { project, runId } = plan;
  const report: CleanupReport = { done: [], failed: [] };
  const jf = journalFile(project, runId);
  const record = (state: { started_at: string; items: (CleanupItem & { done: boolean })[] }) => atomicWrite(jf, JSON.stringify({ run_id: runId, ...state }, null, 2));
  const journal = { started_at: new Date().toISOString(), items: plan.items.map((i) => ({ ...i, done: false })) };
  record(journal);

  for (let n = 0; n < plan.items.length; n++) {
    const item = must(plan.items[n], "cleanup item");
    try {
      if (item.kind === "task-branch") deleteTaskBranch(project.dir, must(item.branch, "task branch"), must(item.tip, "task branch tip"));
      else if (item.kind === "workspace") {
        removeAgentWorkspace(project, runId, item.agent!);
        const dir = path.dirname(item.path!);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } else if (item.kind === "refs") deleteSnapshotRefs(project, runId);
      else safeRemove(project, item.path!);
    } catch (e) {
      report.failed.push({ item, error: (e as Error).message });
      return report; // keep the journal and the run directory: the next `clear` picks up here
    }
    report.done.push(item);
    must(journal.items[n], "journal item").done = true;
    record(journal);
    hooks.afterItem?.(item);
  }
  fs.rmSync(jf, { force: true });
  if (fs.existsSync(journalDir(project)) && fs.readdirSync(journalDir(project)).length === 0) fs.rmdirSync(journalDir(project));
  return report;
}

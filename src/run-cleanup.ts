import fs from "node:fs";
import path from "node:path";
import type { ResolvedProject } from "./config.js";
import { atomicWrite } from "./fs-util.js";
import { assertName } from "./paths.js";
import { loadRunState } from "./run-store.js";
import { runIsAlive } from "./status.js";
import { deleteSnapshotRefs, inspectWorkspace, listSnapshotRefs, listWorkspaceAgents, removeAgentWorkspace } from "./worktree.js";

export interface CleanupItem {
  kind: "workspace" | "refs" | "task-memory" | "run";
  /** One line for people. */
  label: string;
  path?: string;
  agent?: string;
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
  keep: { agent: string; branch: string; path: string; files: string[] }[];
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
 */
export function planRunCleanup(project: ResolvedProject, runId: string, opts: { keepWorktrees?: boolean } = {}): CleanupPlan {
  assertName("run", runId);
  const keepWorktrees = !!opts.keepWorktrees;
  const runDir = path.join(project.paths.runs, runId);
  const hasRun = lexists(path.join(runDir, "state.json"));
  const hasJournal = fs.existsSync(journalFile(project, runId));
  if (!hasRun && !hasJournal) throw new Error(`Run "${runId}" not found in ${project.paths.runs}. List ids with: agent-lyceum status --task-list`);

  const plan: CleanupPlan = { project, runId, runDir, keepWorktrees, items: [], refusals: [], keep: [], summary: runId };
  if (hasRun) {
    const state = loadRunState(runDir);
    plan.summary = `${runId}: ${state.task_summary}`;
    if (!state.end_reason && runIsAlive(state, project)) plan.refusals.push(`Run ${runId} is still running (pid ${state.pid}); stop it first.`);
  }

  for (const agent of listWorkspaceAgents(project, runId)) {
    const w = inspectWorkspace(project, runId, agent);
    if (!w) continue;
    const files = [...new Set([...w.dirty, ...w.unintegrated])];
    const holdsWork = files.length > 0 || !!w.unknown;
    if (keepWorktrees || holdsWork) {
      plan.keep.push({ agent, branch: w.branch, path: w.root, files: files.length ? files : w.unknown ? [`(${w.unknown})`] : [] });
      if (holdsWork && !keepWorktrees) {
        plan.refusals.push(
          `${agent} has work that is not in the repo: ${files.length ? files.join(", ") : w.unknown} (branch ${w.branch}, worktree ${w.root}). ` +
            `Bring it in or discard it by hand, or use --keep-worktrees to keep the worktree and branch and clear the rest.`,
        );
      }
      continue;
    }
    plan.items.push({ kind: "workspace", agent, path: w.root, label: `worktree and branch of ${agent} (${w.root}, ${w.branch}): its work is in the repo` });
  }
  if (!keepWorktrees && listSnapshotRefs(project, runId).length) {
    plan.items.push({ kind: "refs", label: `snapshot refs refs/agent-lyceum/${runId}/*` });
  }
  const mem = path.join(project.paths.taskMemory, runId);
  if (lexists(mem)) plan.items.push({ kind: "task-memory", path: mem, label: `task memory ${mem}` });
  if (hasRun || lexists(runDir)) plan.items.push({ kind: "run", path: runDir, label: `run directory ${runDir} (state, log, result, snapshots, kept violations, mailboxes)` });
  return plan;
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
    const item = plan.items[n];
    try {
      if (item.kind === "workspace") {
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
    journal.items[n].done = true;
    record(journal);
    hooks.afterItem?.(item);
  }
  fs.rmSync(jf, { force: true });
  if (fs.existsSync(journalDir(project)) && fs.readdirSync(journalDir(project)).length === 0) fs.rmdirSync(journalDir(project));
  return report;
}

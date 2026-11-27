import { RunSession, type RunOptions, type RunSummary } from "./run-session.js";
import { newRunId } from "./run-store.js";
import { borrowsCheckout, planWorkspace, toLeadWorktree, type WorkspacePlan } from "./worktree.js";

export { newRunId };
export type { ActiveWake, EndReason, RunState, SentTopic, WakeRecord, WakeTopic } from "./run-store.js";
export { MAX_DONE_REJECTIONS, RESULT_FILE, type RunOptions, type RunSummary } from "./run-session.js";

/** For a caller that passed no plan: a new run that was offered the project checkout works in its own worktree instead (it has taken no checkout lock); a resumed run keeps what its state recorded. */
function defaultPlan(opts: Pick<RunOptions, "project" | "resume">): WorkspacePlan {
  const plan = planWorkspace(opts.project, opts.resume);
  return !opts.resume && borrowsCheckout(plan) ? toLeadWorktree(plan) : plan;
}

/** `plan` is what the CLI decided before taking the run's lock. The CLI always passes it; the fallback exists only for direct callers and tests. */
export async function runTeam(opts: Omit<RunOptions, "plan"> & Partial<Pick<RunOptions, "plan">>): Promise<RunSummary> {
  return new RunSession({ ...opts, plan: opts.plan ?? defaultPlan(opts) }).run();
}

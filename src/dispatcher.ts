import { RunSession, type RunOptions, type RunSummary } from "./run-session.js";
import { newRunId } from "./run-store.js";
import { planWorkspace } from "./worktree.js";

export { newRunId };
export type { ActiveWake, EndReason, RunState, SentTopic, WakeRecord, WakeTopic } from "./run-store.js";
export { MAX_DONE_REJECTIONS, RESULT_FILE, type RunOptions, type RunSummary } from "./run-session.js";

/** `plan` is what the CLI decided before taking the run's lock. The CLI always passes it; the fallback exists only for direct callers and tests. */
export async function runTeam(opts: Omit<RunOptions, "plan"> & Partial<Pick<RunOptions, "plan">>): Promise<RunSummary> {
  return new RunSession({ ...opts, plan: opts.plan ?? planWorkspace(opts.project, opts.resume) }).run();
}

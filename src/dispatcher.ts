import { RunSession, type RunOptions, type RunSummary } from "./run-session.js";
import { newRunId } from "./run-store.js";
import { planWorkspace } from "./worktree.js";

export { newRunId };
export type { ActiveWake, EndReason, RunState, SentTopic, WakeRecord, WakeTopic } from "./run-store.js";
export { MAX_DONE_REJECTIONS, RESULT_FILE, type RunOptions, type RunSummary } from "./run-session.js";

/** `plan` is what the CLI decided before taking the run's lock; a caller without a lock to take (a test, a script) may omit it and get the same probe here. */
export async function runTeam(opts: Omit<RunOptions, "plan"> & Partial<Pick<RunOptions, "plan">>): Promise<RunSummary> {
  return new RunSession({ ...opts, plan: opts.plan ?? planWorkspace(opts.project, opts.resume) }).run();
}

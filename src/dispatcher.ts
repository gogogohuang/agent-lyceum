import { RunSession, type RunOptions, type RunSummary } from "./run-session.js";
import { newRunId } from "./run-store.js";

export { newRunId };
export type { ActiveWake, EndReason, RunState, SentTopic, WakeRecord, WakeTopic } from "./run-store.js";
export { MAX_DONE_REJECTIONS, RESULT_FILE, type RunOptions, type RunSummary } from "./run-session.js";

export async function runTeam(opts: RunOptions): Promise<RunSummary> {
  return new RunSession(opts).run();
}

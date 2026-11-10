import type { Run } from "../types";

/** A run is idle (resume/clear allowed) when it is not running, or claims to run but its dispatcher is gone. */
export function isIdleRun(run: Pick<Run, "state" | "live"> | undefined): boolean {
  if (!run) return false;
  return run.state !== "running" || run.live === false;
}

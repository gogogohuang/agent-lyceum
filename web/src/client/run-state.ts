import type { Run } from "../types";

/** A run is idle (resume/clear allowed) when it is not running, or claims to run but its dispatcher is gone. */
export function isIdleRun(run: Pick<Run, "state" | "live"> | undefined): boolean {
  if (!run) return false;
  return run.state !== "running" || run.live === false;
}

/** Started with `run --tidy`. Runs from before the flag are told by their name (`--name …-tidy`). */
export function isTidyRun(run: Pick<Run, "name" | "tidy"> | undefined): boolean {
  return run?.tidy === true || /tidy/i.test(run?.name ?? "");
}

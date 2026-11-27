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

export type TidyTone = "progress" | "ok" | "warn" | "fail";
export type TidyBadgeInfo = { text: string; tone: TidyTone };

/** Shared by every tidy badge. `ok` is `text-signal`; `progress` stays neutral so it is not the success colour. */
export const TIDY_TONE_CLASS: Record<TidyTone, string> = {
  progress: "text-ink/70",
  ok: "text-signal",
  warn: "text-warn",
  fail: "text-failed",
};

/** Badge for a tidy run. First match wins; not a tidy run → none. Success is only `completed` with `end_reason` `done`. */
export function tidyBadge(run: Pick<Run, "name" | "tidy" | "state" | "live" | "outcome" | "end_reason"> | undefined): TidyBadgeInfo | undefined {
  if (!isTidyRun(run) || !run) return undefined;
  if (run.state === "running" && run.live !== false) return { text: "tidy 進行中", tone: "progress" };
  if (run.outcome === "failed" || run.end_reason === "lead_failed" || run.end_reason === "agent_failed") return { text: "tidy 失敗", tone: "fail" };
  if (run.outcome === "completed" && run.end_reason === "done") return { text: "已 tidy", tone: "ok" };
  return { text: "tidy 未完成", tone: "warn" };
}

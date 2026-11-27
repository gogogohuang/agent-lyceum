import { describe, expect, it } from "vitest";
import { isIdleRun, isTidyRun, tidyBadge, TIDY_TONE_CLASS } from "../web/src/client/run-state";

describe("isIdleRun", () => {
  it("covers the cases", () => {
    expect(isIdleRun(undefined)).toBe(false);
    expect(isIdleRun({ state: "done" } as never)).toBe(true);
    expect(isIdleRun({ state: "running", live: true } as never)).toBe(false);
    expect(isIdleRun({ state: "running", live: false } as never)).toBe(true);
    expect(isIdleRun({ state: "running" } as never)).toBe(false);
  });
});

describe("isTidyRun", () => {
  it("matches a run named for tidy", () => {
    expect(isTidyRun(undefined)).toBe(false);
    expect(isTidyRun({} as never)).toBe(false);
    expect(isTidyRun({ tidy: true, name: "x" })).toBe(true);
    expect(isTidyRun({ name: "LT-29363-api-tidy" })).toBe(true);
    expect(isTidyRun({ name: "LT-1-Tidy-commits" })).toBe(true);
    expect(isTidyRun({ name: "LT-1-api" })).toBe(false);
  });
});

describe("tidyBadge", () => {
  const progress = { text: "tidy 進行中", tone: "progress" as const };
  const ok = { text: "已 tidy", tone: "ok" as const };
  const fail = { text: "tidy 失敗", tone: "fail" as const };
  const warn = { text: "tidy 未完成", tone: "warn" as const };

  it("is absent unless the run is tidy", () => {
    expect(tidyBadge(undefined)).toBeUndefined();
    expect(tidyBadge({ name: "LT-1-api", state: "ended", outcome: "completed" })).toBeUndefined();
    expect(tidyBadge({ tidy: false, name: "plain", state: "running", live: true })).toBeUndefined();
  });

  it("shows progress while a tidy run is live, including a name-only legacy run", () => {
    expect(tidyBadge({ tidy: true, state: "running", live: true })).toEqual(progress);
    expect(tidyBadge({ tidy: true, state: "running" })).toEqual(progress);
    expect(tidyBadge({ name: "LT-1-tidy", state: "running", live: true, outcome: "completed" })).toEqual(progress);
  });

  it("shows success only when the outcome is completed and end_reason is done", () => {
    expect(tidyBadge({ tidy: true, state: "ended", outcome: "completed", end_reason: "done" })).toEqual(ok);
    expect(tidyBadge({ name: "old-tidy", state: "ended", outcome: "completed", end_reason: "done" })).toEqual(ok);
    expect(tidyBadge({ tidy: true, state: "running", live: false, outcome: "completed", end_reason: "done" })).toEqual(ok);
  });

  it("shows failure for outcome failed or a lead/agent failure, ahead of a completed outcome", () => {
    expect(tidyBadge({ tidy: true, state: "ended", outcome: "failed" })).toEqual(fail);
    expect(tidyBadge({ tidy: true, state: "ended", end_reason: "agent_failed" })).toEqual(fail);
    expect(tidyBadge({ tidy: true, state: "ended", end_reason: "lead_failed", outcome: "partial" })).toEqual(fail);
    expect(tidyBadge({ name: "legacy-tidy", state: "ended", end_reason: "agent_failed" })).toEqual(fail);
    expect(tidyBadge({ tidy: true, state: "ended", outcome: "completed", end_reason: "agent_failed" })).toEqual(fail);
  });

  it("shows unfinished for every other tidy result", () => {
    expect(tidyBadge({ tidy: true, state: "ended", outcome: "partial", end_reason: "max_rounds" })).toEqual(warn);
    expect(tidyBadge({ tidy: true, state: "ended", outcome: "blocked" })).toEqual(warn);
    expect(tidyBadge({ tidy: true, state: "ended", outcome: "cancelled" })).toEqual(warn);
    expect(tidyBadge({ tidy: true, state: "waiting", outcome: "waiting", end_reason: "waiting" })).toEqual(warn);
    expect(tidyBadge({ tidy: true, state: "ended", end_reason: "idle" })).toEqual(warn);
    expect(tidyBadge({ tidy: true, state: "interrupted" })).toEqual(warn);
    expect(tidyBadge({ tidy: true, state: "running", live: false })).toEqual(warn);
    expect(tidyBadge({ name: "LT-29363-api-tidy", state: "ended" })).toEqual(warn);
    expect(tidyBadge({ name: "old-tidy", state: "ended", outcome: "completed" })).toEqual(warn);
    expect(tidyBadge({ tidy: true, state: "running", live: false, outcome: "completed" })).toEqual(warn);
  });

  it("keeps ok off the warn and fail colours, and progress off ok", () => {
    expect(TIDY_TONE_CLASS.ok).toBe("text-signal");
    expect(TIDY_TONE_CLASS.warn).toBe("text-warn");
    expect(TIDY_TONE_CLASS.fail).toBe("text-failed");
    expect(TIDY_TONE_CLASS.progress).not.toBe(TIDY_TONE_CLASS.ok);
    expect(new Set([TIDY_TONE_CLASS.ok, TIDY_TONE_CLASS.warn, TIDY_TONE_CLASS.fail]).size).toBe(3);
  });
});

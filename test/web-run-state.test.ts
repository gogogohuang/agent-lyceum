import { describe, expect, it } from "vitest";
import { isIdleRun, isRunControlLocked, isTidyRun } from "../web/src/client/run-state";

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

describe("isRunControlLocked", () => {
  it("shuts every control once a run is marked tidy", () => {
    expect(isRunControlLocked(undefined)).toBe(false);
    expect(isRunControlLocked({ name: "LT-1-api" })).toBe(false);
    expect(isRunControlLocked({ tidy: true, name: "x" })).toBe(true);
    expect(isRunControlLocked({ name: "LT-29363-api-tidy" })).toBe(true);
  });
});

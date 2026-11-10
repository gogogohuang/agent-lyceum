import { describe, expect, it } from "vitest";
import { isIdleRun } from "../web/src/client/run-state";

describe("isIdleRun", () => {
  it("covers the cases", () => {
    expect(isIdleRun(undefined)).toBe(false);
    expect(isIdleRun({ state: "done" } as never)).toBe(true);
    expect(isIdleRun({ state: "running", live: true } as never)).toBe(false);
    expect(isIdleRun({ state: "running", live: false } as never)).toBe(true);
    expect(isIdleRun({ state: "running" } as never)).toBe(false);
  });
});

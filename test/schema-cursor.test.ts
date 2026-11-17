import { describe, expect, it } from "vitest";
import { inferRuntime, isGrokModel, RUNTIME_EFFORTS, RUNTIMES } from "../src/schema.js";

describe("cursor schema", () => {
  it("lists cursor and accepts no efforts", () => {
    expect(RUNTIMES).toContain("cursor");
    expect(RUNTIME_EFFORTS.cursor).toEqual([]);
  });

  it("isGrokModel and inferRuntime", () => {
    expect(isGrokModel("grok-4.7")).toBe(true);
    expect(isGrokModel("Grok-4.6")).toBe(true);
    expect(isGrokModel("composer-2.5")).toBe(false);
    expect(isGrokModel("auto")).toBe(false);
    expect(inferRuntime("grok-4.7")).toBe("cursor");
    expect(inferRuntime("opus")).toBe("claude-code");
    expect(inferRuntime("gpt-5")).toBe("codex");
  });
});
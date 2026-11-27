import { describe, expect, it } from "vitest";
import { capBatch, DEFAULT_MAX_AWAKE } from "../src/wake-cap.js";

const agents = (names: string[]) => names.map((name) => ({ name }));

describe("capBatch", () => {
  it("wakes the lead alone", () => {
    expect(capBatch(agents(["fe", "lead", "qa"]), "lead", "worktree", 8).map((a) => a.name)).toEqual(["lead"]);
  });
  it("caps members in worktree mode and keeps order", () => {
    expect(capBatch(agents(["a", "b", "c"]), "lead", "worktree", 2).map((a) => a.name)).toEqual(["a", "b"]);
  });
  it("wakes one agent in shared mode", () => {
    expect(capBatch(agents(["a", "b"]), "lead", "shared", 8).map((a) => a.name)).toEqual(["a"]);
  });
  it("still wakes one member when the cap is below 1", () => {
    expect(capBatch(agents(["a", "b"]), "lead", "worktree", 0).map((a) => a.name)).toEqual(["a"]);
  });
  it("defaults to 8", () => {
    expect(DEFAULT_MAX_AWAKE).toBe(8);
  });
});

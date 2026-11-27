import { describe, expect, it } from "vitest";
import { acceptanceIssues } from "../src/format.js";

describe("acceptanceIssues", () => {
  it("accepts a command, a file or a test name", () => {
    expect(acceptanceIssues("## Acceptance criteria\n- `npm test` passes")).toEqual([]);
    expect(acceptanceIssues("## Acceptance criteria\n- src/format.ts exports acceptanceIssues")).toEqual([]);
  });
  it("rejects a placeholder and a missing check", () => {
    expect(acceptanceIssues("## Acceptance criteria\n- as stated in the goal")).toEqual([
      "Acceptance criteria has no checkable item (a `command`, a file or a test name)",
    ]);
    expect(acceptanceIssues("## Acceptance criteria\nNone")).toEqual([
      "Acceptance criteria has no checkable item (a `command`, a file or a test name)",
    ]);
    expect(acceptanceIssues("## Acceptance criteria\n- `None`")).toEqual([
      "Acceptance criteria has no checkable item (a `command`, a file or a test name)",
    ]);
  });
  it("does not complain when the heading itself is absent", () => {
    expect(acceptanceIssues("## Goal\nship it")).toEqual([]);
  });
});

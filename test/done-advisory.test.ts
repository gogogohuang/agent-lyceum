import { describe, expect, it } from "vitest";
import { doneContract } from "../src/format.js";

const base = "## Result\nx\n## Files\nx\n## Verification\nran\n## Decisions\nNone\n## Not done\nNone\n";

describe("done advisory sections", () => {
  it("warns, without rejecting, when a completed report has no Spot-check or Quiz", () => {
    const c = doneContract({ outcome: "completed" }, base);
    expect(c.missing).toEqual([]);
    expect(c.warnings).toEqual(["`## Spot-check`", "`## Quiz`"]);
  });
  it("is quiet when both are present", () => {
    const c = doneContract({ outcome: "completed" }, `${base}## Spot-check\nx\n## Quiz\nx\n`);
    expect(c.missing).toEqual([]);
    expect(c.warnings).toEqual([]);
  });
  it("does not warn for partial reports", () => {
    expect(doneContract({ outcome: "partial" }, "## Result\nx\n## Not done\ny\n").warnings).toEqual([]);
  });
});

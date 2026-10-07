import { describe, expect, it } from "vitest";
import { endOutcome, resolveDoneOutcome } from "../src/run-outcome.js";

describe("resolveDoneOutcome", () => {
  it("accepts a done that meets the contract with the outcome the lead declared", () => {
    expect(resolveDoneOutcome({ outcome: "completed", missing: [], verification: "npm test: passed" }, 0, [])).toEqual({
      outcome: "completed",
      note: undefined,
      verification: "npm test: passed",
    });
  });

  it("downgrades a done that still breaks the contract to partial and says what was missing", () => {
    const r = resolveDoneOutcome({ outcome: "completed", missing: ["## Files", "## Not done"] }, 2, []);
    expect(r.outcome).toBe("partial");
    expect(r.note).toBe("Completion contract not met after 2 reminder(s): missing ## Files; ## Not done. Reported as partial; the lead's report is kept as written.");
  });

  it("will not call the job completed while a member's work is not in the repo", () => {
    const r = resolveDoneOutcome({ outcome: "completed", missing: [] }, 0, [
      { agent: "fe", branch: "agent-lyceum/r/fe", report: "/r/fe.md" },
      { agent: "qa", branch: "agent-lyceum/r/qa", report: "/r/qa.md" },
    ]);
    expect(r.outcome).toBe("blocked");
    expect(r.note).toBe("Not completed: work of fe (branch agent-lyceum/r/fe), qa (branch agent-lyceum/r/qa) was never brought into the repo; see /r/fe.md, /r/qa.md.");
  });

  it("keeps partial and blocked reports as they are, even with unintegrated work", () => {
    expect(resolveDoneOutcome({ outcome: "partial", missing: [] }, 0, [{ agent: "fe", branch: "b", report: "r" }]).outcome).toBe("partial");
    expect(resolveDoneOutcome({ outcome: "blocked", missing: [] }, 0, []).outcome).toBe("blocked");
  });
});

describe("endOutcome", () => {
  it("takes the lead's outcome when the run ended with a done", () => {
    expect(endOutcome("done", { outcome: "completed" })).toEqual({ outcome: "completed", note: undefined });
    expect(endOutcome("done", { outcome: "blocked", note: "n" })).toEqual({ outcome: "blocked", note: "n" });
  });

  it("maps every other end reason", () => {
    expect(endOutcome("lead_failed")).toEqual({ outcome: "failed", note: "The lead's wake-up failed." });
    expect(endOutcome("cancelled").outcome).toBe("cancelled");
    expect(endOutcome("cancelled").note).toContain("agent-lyceum resume");
    expect(endOutcome("idle")).toEqual({ outcome: "partial", note: "All mailboxes were empty but the lead never sent a done message." });
    expect(endOutcome("max_rounds")).toEqual({ outcome: "partial", note: "Stopped at the round limit before the lead sent done." });
  });
});

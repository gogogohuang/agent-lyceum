import { describe, expect, it } from "vitest";
import { crossRuntimeBlock } from "../src/review-gate.js";
import type { ResolvedProject } from "../src/config.js";

function project(runtimes: Record<string, string>): ResolvedProject {
  const agents = Object.fromEntries(Object.entries(runtimes).map(([name, runtime]) => [name, { name, runtime }]));
  return { lead: "lead", agents } as unknown as ResolvedProject;
}

describe("crossRuntimeBlock", () => {
  it("stays open when every agent shares a runtime", () => {
    expect(crossRuntimeBlock(project({ lead: "claude-code", fe: "claude-code" }), { implementers: [{ agent: "fe" }] }, "worktree")).toBeUndefined();
  });
  it("names the other runtime when nobody has passed", () => {
    const why = crossRuntimeBlock(
      project({ lead: "claude-code", fe: "claude-code", qa: "codex" }),
      { implementers: [{ agent: "fe" }], reviews: [] },
      "worktree",
    );
    expect(why).toContain("qa");
    expect(why).toContain("verdict: pass");
  });
  it("accepts a pass from the other runtime in this segment", () => {
    expect(
      crossRuntimeBlock(
        project({ lead: "claude-code", fe: "claude-code", qa: "codex" }),
        {
          implementers: [{ agent: "fe" }],
          reopened: [{ at: "2026-11-27T00:00:00.000Z" }],
          reviews: [
            { reviewer: "qa", verdict: "pass", at: "2026-11-26T00:00:00.000Z" },
            { reviewer: "qa", verdict: "pass", at: "2026-11-27T01:00:00.000Z" },
          ],
        },
        "worktree",
      ),
    ).toBeUndefined();
  });
  it("ignores a pass from before the reopen", () => {
    expect(
      crossRuntimeBlock(
        project({ lead: "claude-code", fe: "claude-code", qa: "codex" }),
        {
          implementers: [{ agent: "fe" }],
          reopened: [{ at: "2026-11-27T00:00:00.000Z" }],
          reviews: [{ reviewer: "qa", verdict: "pass", at: "2026-11-26T00:00:00.000Z" }],
        },
        "worktree",
      ),
    ).toContain("qa");
  });
  it("shared mode treats the member who handled a task as the author, so their own pass does not clear the gate", () => {
    const why = crossRuntimeBlock(
      project({ lead: "claude-code", fe: "codex", qa: "claude-code" }),
      {
        implementers: [],
        wakes: [{ agent: "fe", at: "2026-11-27T01:00:00.000Z", handling: [{ type: "task" }] }],
        reviews: [{ reviewer: "fe", verdict: "pass", at: "2026-11-27T02:00:00.000Z" }],
      },
      "shared",
    );
    expect(why).toContain("qa");
  });
  it("ignores the lead's own pass", () => {
    const why = crossRuntimeBlock(
      project({ lead: "claude-code", fe: "codex", qa: "claude-code" }),
      {
        implementers: [{ agent: "fe" }],
        reviews: [{ reviewer: "lead", verdict: "pass", at: "2026-11-27T01:00:00.000Z" }],
      },
      "worktree",
    );
    expect(why).toContain("qa");
  });
  it("stays closed when only the lead uses another runtime", () => {
    const why = crossRuntimeBlock(
      project({ lead: "codex", fe: "claude-code", qa: "claude-code" }),
      {
        implementers: [{ agent: "fe" }],
        reviews: [{ reviewer: "lead", verdict: "pass", at: "2026-11-27T01:00:00.000Z" }],
      },
      "worktree",
    );
    expect(why).toContain("verdict: pass");
    expect(why).toContain("(none)");
  });
  it("stays closed when the other runtime also wrote code", () => {
    const why = crossRuntimeBlock(
      project({ lead: "claude-code", fe: "claude-code", qa: "codex" }),
      {
        implementers: [{ agent: "fe" }, { agent: "qa" }],
        reviews: [{ reviewer: "qa", verdict: "pass", at: "2026-11-27T01:00:00.000Z" }],
      },
      "worktree",
    );
    expect(why).toContain("verdict: pass");
    expect(why).toContain("(none)");
  });
  it("worktree mode still accepts a pass from QA who was only sent a review task", () => {
    expect(
      crossRuntimeBlock(
        project({ lead: "claude-code", fe: "claude-code", qa: "codex" }),
        {
          implementers: [{ agent: "fe" }],
          wakes: [{ agent: "qa", at: "2026-11-27T01:00:00.000Z", handling: [{ type: "task" }] }],
          reviews: [{ reviewer: "qa", verdict: "pass", at: "2026-11-27T02:00:00.000Z" }],
        },
        "worktree",
      ),
    ).toBeUndefined();
  });
});

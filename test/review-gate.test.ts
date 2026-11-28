import { describe, expect, it } from "vitest";
import { crossRuntimeBlock, teamRunFindings } from "../src/review-gate.js";
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
  it("does not treat a shared-folder task, even without read_only, as authorship", () => {
    expect(
      crossRuntimeBlock(
        project({ lead: "claude-code", fe: "codex", qa: "claude-code" }),
        {
          implementers: [],
          wakes: [{ agent: "fe", at: "2026-11-27T01:00:00.000Z", handling: [{ type: "task" }] }],
          reviews: [{ reviewer: "fe", verdict: "pass", at: "2026-11-27T02:00:00.000Z" }],
        },
        "shared",
      ),
    ).toBeUndefined();
  });
  it("turns the gate off when verify.cross_runtime is false", () => {
    const p = project({ lead: "claude-code", fe: "codex", qa: "claude-code" });
    p.verify = { max_rejections: 2, bind_task: false, cross_runtime: false, commands: [] };
    expect(
      crossRuntimeBlock(p, { implementers: [{ agent: "fe", at: "2026-11-27T01:00:00.000Z" }], reviews: [] }, "worktree"),
    ).toBeUndefined();
  });
  it("ignores an implementer from before the reopen", () => {
    expect(
      crossRuntimeBlock(
        project({ lead: "claude-code", fe: "codex", qa: "claude-code" }),
        {
          implementers: [{ agent: "fe", at: "2026-11-26T00:00:00.000Z" }],
          reopened: [{ at: "2026-11-27T00:00:00.000Z" }],
          reviews: [{ reviewer: "fe", verdict: "pass", at: "2026-11-27T02:00:00.000Z" }],
        },
        "worktree",
      ),
    ).toBeUndefined();
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
  it("does not block when only the lead uses another runtime", () => {
    expect(
      crossRuntimeBlock(
        project({ lead: "codex", fe: "claude-code", qa: "claude-code" }),
        {
          implementers: [{ agent: "fe", at: "2026-11-27T01:00:00.000Z" }],
          reviews: [{ reviewer: "lead", verdict: "pass", at: "2026-11-27T01:00:00.000Z" }],
        },
        "worktree",
      ),
    ).toBeUndefined();
  });
  it("does not block when the other runtime also wrote code", () => {
    expect(
      crossRuntimeBlock(
        project({ lead: "claude-code", fe: "claude-code", qa: "codex" }),
        {
          implementers: [
            { agent: "fe", at: "2026-11-27T01:00:00.000Z" },
            { agent: "qa", at: "2026-11-27T01:00:00.000Z" },
          ],
          reviews: [{ reviewer: "qa", verdict: "pass", at: "2026-11-27T01:00:00.000Z" }],
        },
        "worktree",
      ),
    ).toBeUndefined();
  });
  it("notes when the lead cannot delegate, and when only the lead uses another runtime", () => {
    const blocked = project({ lead: "claude-code", fe: "codex" });
    blocked.agents.lead!.canMessage = [];
    blocked.agents.fe!.canMessage = ["lead"];
    const found = teamRunFindings(blocked);
    expect(found.map((f) => f.level)).toEqual(["info", "warn", "info"]);
    expect(found[0]!.message).toContain("does not edit the repository");
    expect(found[0]!.message).toContain("run --agent");
    expect(found[1]!.message).toContain("cannot send work");
    expect(found[2]!.message).toContain("cross_runtime");
  });
  it("stays quiet for a solo run and for a team that can still get a pass", () => {
    const solo = project({ lead: "claude-code", fe: "codex" });
    solo.solo = "run";
    expect(teamRunFindings(solo)).toEqual([]);
    const ok = project({ lead: "claude-code", fe: "codex", qa: "cursor" });
    ok.agents.lead!.canMessage = "all";
    expect(teamRunFindings(ok).map((f) => f.level)).toEqual(["info"]);
    expect(teamRunFindings(ok)[0]!.message).toContain("run --agent");
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

import { describe, expect, it } from "vitest";
import { acceptanceIssues } from "../src/format.js";
import { PLAYBOOK_SECTION } from "../src/prompt.js";
import { followupAcceptance } from "../src/run-session.js";

describe("playbook prompt", () => {
  it("names the four playbooks", () => {
    expect(PLAYBOOK_SECTION.join("\n")).toContain("investigate, fix, feature, refactor");
  });
  it("the follow-up acceptance line that deliver() uses is checkable", () => {
    const line = followupAcceptance("/tmp/run/task.md");
    expect(acceptanceIssues(`## Acceptance criteria\n${line}`)).toEqual([]);
  });
});

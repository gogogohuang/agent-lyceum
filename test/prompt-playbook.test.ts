import { afterEach, describe, expect, it } from "vitest";
import { acceptanceIssues } from "../src/format.js";
import { buildSoloSystemPrompt, buildSystemPrompt, PLAYBOOK_SECTION } from "../src/prompt.js";
import { followupAcceptance } from "../src/run-session.js";
import { soloProject } from "../src/solo.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
afterEach(() => env?.cleanup());

describe("playbook prompt", () => {
  it("names the four playbooks", () => {
    expect(PLAYBOOK_SECTION.join("\n")).toContain("investigate, fix, feature, refactor");
  });
  it("the follow-up acceptance line that deliver() uses is checkable", () => {
    const line = followupAcceptance("/tmp/run/task.md");
    expect(acceptanceIssues(`## Acceptance criteria\n${line}`)).toEqual([]);
  });

  it("tells a team lead not to edit product code, and leaves a solo agent able to", () => {
    env = makeEnv();
    const project = env.project();
    const lead = project.agents.lead!;
    expect(buildSystemPrompt(project, lead)).toContain("You do not edit product code.");
    const solo = soloProject(project, "fe-member");
    expect(buildSoloSystemPrompt(solo, solo.agents["fe-member"]!)).not.toContain("You do not edit product code.");
  });
});

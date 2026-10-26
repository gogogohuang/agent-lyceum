import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { WAKE_ECONOMY_SECTION, buildSoloSystemPrompt, buildSystemPrompt } from "../src/prompt.js";
import { bindRunProject } from "../src/run-store.js";
import { GLOBAL_TEAM_YAML } from "../src/scaffold.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("wake-up economy section", () => {
  it("is in the lead prompt after Progress tracking, not in member or solo prompts", () => {
    env = makeEnv();
    const base = env.project();
    const p = bindRunProject(base, path.join(base.paths.runs, "run-a"), "run");
    const text = WAKE_ECONOMY_SECTION.join("\n");
    const lead = buildSystemPrompt(p, p.agents.lead);
    expect(lead).toContain(text);
    expect(lead.indexOf("## Progress tracking")).toBeLessThan(lead.indexOf("## Keeping wake-ups few"));
    const member = Object.values(p.agents).find((a) => a.name !== p.lead);
    expect(member).toBeDefined();
    expect(buildSystemPrompt(p, member as never)).not.toContain("Keeping wake-ups few");
    expect(buildSoloSystemPrompt(p, p.agents.lead)).not.toContain("Keeping wake-ups few");
  });
});

describe("scaffold team.yaml", () => {
  it("parses to the same agents as the comment-free version", () => {
    const stripped = GLOBAL_TEAM_YAML.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(parse(GLOBAL_TEAM_YAML)).toEqual(parse(stripped));
    expect(Object.keys(parse(GLOBAL_TEAM_YAML).agents)).toEqual(["lead", "fe-member", "qa-member"]);
    expect(parse(GLOBAL_TEAM_YAML).agents.lead).toEqual({ runtime: "claude-code", agent_md: "agents/lead/AGENT.md", memory: { global: "agents/lead/memory" } });
  });
});

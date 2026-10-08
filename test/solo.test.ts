import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadGlobal, resolveProjectFrom } from "../src/config.js";
import { writePolicy } from "../src/policy.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { bindRunProject } from "../src/run-store.js";
import { soloProject } from "../src/solo.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("resolveProjectFrom", () => {
  it("resolves an agent from the global library alone, with no project.yaml", () => {
    env = makeEnv();
    const p = resolveProjectFrom(env.home, "(call)", loadGlobal(env.home), {
      dir: env.repo,
      team: { lead: "fe-member" },
      dispatcher: {},
      agents: { "fe-member": {} },
    });
    const a = p.agents["fe-member"]!;
    expect(a.runtime).toBe("claude-code");
    expect(a.agentMd).toBe(path.join(env.home, "agents/fe-member/AGENT.md"));
    expect(a.memory.global).toBe(path.join(env.home, "agents/fe-member/memory"));
    expect(p.dir).toBe(env.repo);
  });
});

describe("soloProject", () => {
  it("makes the chosen agent the lead that cannot mail, ask or edit, and keeps every member", () => {
    env = makeEnv();
    const p = soloProject(env.project(), "fe-member");
    expect(p.solo).toBe("run");
    expect(p.lead).toBe("fe-member");
    expect(Object.keys(p.agents)).toEqual(["lead", "fe-member", "qa-member"]);
    const a = p.agents["fe-member"]!;
    expect([a.canMessage, a.canAskUser, a.canEditAgentMd, a.owns]).toEqual([[], false, false, []]);
    expect(p.dispatcher.max_parallel).toBe(1);
    expect(p.dispatcher.workspace_mode).toBe("shared");
  });

  it("does not change the project it was given", () => {
    env = makeEnv();
    const base = env.project();
    soloProject(base, "fe-member");
    expect(base.lead).toBe("lead");
    expect(base.agents["fe-member"]!.canMessage).toEqual(["lead"]);
  });

  it("names the project's members when the agent is not one of them, and points a global-only agent to `call`", () => {
    env = makeEnv();
    expect(() => soloProject(env.project(), "nobody")).toThrow(ConfigError);
    expect(() => soloProject(env.project(), "nobody")).toThrow(/lead, fe-member, qa-member/);
    // pretend `pm` exists in the global library only
    const p = env.project();
    expect(() => soloProject(p, "pm", { globalAgents: ["pm"] })).toThrow(/agent-lyceum call pm/);
  });

  it("a solo lead may not write COMMON.md, and a solo agent's prompt has no teammates or ask", () => {
    env = makeEnv();
    const p = bindRunProject(soloProject(env.project(), "fe-member"), path.join(env.project().paths.runs, "r1"), "run");
    const pol = writePolicy(p, p.agents["fe-member"]!);
    expect(pol.allowFiles).toEqual([]);
    const sys = buildSystemPrompt(p, p.agents["fe-member"]!);
    expect(sys).toMatch(/working alone/);
    expect(sys).toMatch(/type: done/);
    expect(sys).not.toMatch(/Teammates/);
    expect(sys).not.toMatch(/Asking the user/);
  });
});

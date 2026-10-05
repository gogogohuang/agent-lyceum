import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findProjectForCwd, resolveProject } from "../src/config.js";
import { inferRuntime } from "../src/schema.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("config merge", () => {
  it("applies role defaults and inherits global fields", () => {
    env = makeEnv();
    const p = env.project();
    expect(Object.keys(p.agents)).toEqual(["lead", "fe-member", "qa-member"]);
    expect(p.agents.lead.resume).toBe(true);
    expect(p.agents["fe-member"].resume).toBe(false);
    expect(p.agents["fe-member"].canMessage).toEqual(["lead"]);
    expect(p.agents.lead.canMessage).toBe("all");
    expect(p.agents["fe-member"].runtime).toBe("claude-code");
    expect(p.agents["fe-member"].sources.runtime).toBe("global");
    expect(p.agents["fe-member"].agentMd).toBe(path.join(env.home, "agents/fe-member/AGENT.md"));
  });

  it("project values override global, arrays are replaced, memory keys merge", () => {
    env = makeEnv();
    env.editProjectYaml((t) =>
      t.replace(
        "  fe-member:\n    can_message: [lead]",
        "  fe-member:\n    runtime: codex\n    can_message: [lead, qa-member]\n    memory: { project: agents/fe-member/memory }",
      ),
    );
    const fe = env.project().agents["fe-member"];
    expect(fe.runtime).toBe("codex");
    expect(fe.sources.runtime).toBe("project");
    expect(fe.canMessage).toEqual(["lead", "qa-member"]);
    expect(fe.memory.global).toBe(path.join(env.home, "agents/fe-member/memory"));
    expect(fe.memory.project).toBe(path.join(env.home, "projects/demo/agents/fe-member/memory"));
  });

  it("defaults project memory when none is configured and prefers a project-level AGENT.md", () => {
    env = makeEnv();
    fs.writeFileSync(
      path.join(env.home, "team.yaml"),
      "agents:\n  lead: { runtime: claude-code }\n  fe-member: { runtime: claude-code }\n  qa-member: { runtime: claude-code }\n",
    );
    const projAgent = path.join(env.home, "projects/demo/agents/qa-member/AGENT.md");
    fs.mkdirSync(path.dirname(projAgent), { recursive: true });
    fs.writeFileSync(projAgent, "# qa override");
    const p = env.project();
    expect(p.agents["qa-member"].agentMd).toBe(projAgent);
    expect(p.agents["qa-member"].memory.project).toBe(path.join(env.home, "projects/demo/agents/qa-member/memory"));
    expect(p.agents.lead.agentMd).toBe(path.join(env.home, "agents/lead/AGENT.md"));
  });

  it("rejects unknown fields with a readable error", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t + "\nbogus: 1\n");
    expect(() => resolveProject(env.home, "demo")).toThrow(/bogus|Unrecognized/);
  });

  it("finds the project by cwd using the longest matching dir", () => {
    env = makeEnv();
    const sub = path.join(env.repo, "src", "web");
    fs.mkdirSync(sub, { recursive: true });
    expect(findProjectForCwd(env.home, sub)).toBe("demo");
    expect(findProjectForCwd(env.home, env.root)).toBeUndefined();
  });
});

describe("runtime inference from model", () => {
  it("recognizes Claude and OpenAI/Codex model names", () => {
    for (const m of ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5[1m]"]) expect(inferRuntime(m)).toBe("claude-code");
    for (const m of ["gpt-5", "gpt-5-codex", "o3", "codex-mini-latest"]) expect(inferRuntime(m)).toBe("codex");
    expect(inferRuntime("mystery")).toBeUndefined();
    expect(inferRuntime(undefined)).toBeUndefined();
  });

  it("a project model overrides the inherited global runtime; an explicit runtime still wins", () => {
    env = makeEnv();
    env.editProjectYaml((t) =>
      t.replace("  fe-member:\n    can_message: [lead]", "  fe-member:\n    model: gpt-5\n    can_message: [lead]"),
    );
    const fe = env.project().agents["fe-member"];
    expect(fe.runtime).toBe("codex");
    expect(fe.sources.runtime).toBe("model");

    env.editProjectYaml((t) => t.replace("    model: gpt-5\n", "    model: gpt-5\n    runtime: claude-code\n"));
    expect(env.project().agents["fe-member"].runtime).toBe("claude-code");
  });
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateProject } from "../src/validate.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());
const errors = (env: TestEnv) => validateProject(env.project()).issues.filter((i) => i.level === "error").map((i) => i.message);

describe("validate", () => {

  it("accepts the generated template project", () => {
    env = makeEnv();
    expect(errors(env)).toEqual([]);
  });

  it("accepts a team of two (the lead and one member)", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace(/ {2}qa-member:[\s\S]*$/, ""));
    expect(Object.keys(env.project().agents)).toEqual(["lead", "fe-member"]);
    expect(errors(env)).toEqual([]);
  });

  it("rejects a team of one", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace(/ {2}fe-member:[\s\S]*$/, ""));
    expect(errors(env).join("\n")).toMatch(/at least 2 agents/);
  });

  it("rejects a team without a lead even when it has two members", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("lead: lead", "lead: ghost"));
    expect(errors(env).join("\n")).toMatch(/Lead "ghost"/);
  });

  it("requires the lead to be a listed agent", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("lead: lead", "lead: ghost"));
    expect(errors(env).join("\n")).toMatch(/Lead "ghost"/);
  });

  it("flags unknown can_message targets and missing AGENT.md", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("can_message: [lead]", "can_message: [nobody]"));
    fs.rmSync(path.join(env.home, "agents/qa-member/AGENT.md"));
    const e = errors(env).join("\n");
    expect(e).toMatch(/"nobody"/);
    expect(e).toMatch(/AGENT\.md not found/);
  });

  it("detects overlapping memory directories", () => {
    env = makeEnv();
    // lead's global memory is <home>/agents/lead/memory; put fe-member's inside it
    env.editProjectYaml((t) =>
      t.replace(
        "    # memory: { project: agents/fe-member/memory }",
        `    memory: { global: ${path.join(env.home, "agents/lead/memory/sub")} }`,
      ),
    );
    expect(errors(env).join("\n")).toMatch(/Memory dirs overlap/);
  });

  it("strict fails when protection is not OS-enforced", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("strict: false", "strict: true"));
    const res = validateProject(env.project());
    const osOk = res.enforcement.every((e) => e.memory === "os");
    expect(res.ok).toBe(osOk);
  });

  it("reports Codex repo instruction files as post-hoc", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("  fe-member:\n    can_message", "  fe-member:\n    runtime: codex\n    can_message"));
    const e = validateProject(env.project()).enforcement.find((x) => x.agent === "fe-member")!;
    expect(e.repoInstructions).toBe("post-hoc");
  });

  const feAgent = "  fe-member:\n    can_message";

  it("errors when runtime cannot be determined", () => {
    env = makeEnv();
    const file = path.join(env.home, "team.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n {4}runtime: claude-code\n {4}agent_md: agents\/fe-member/, "\n    agent_md: agents/fe-member"));
    env.editProjectYaml((t) => t.replace(feAgent, "  fe-member:\n    model: my-custom-model\n    can_message"));
    expect(errors(env).join("\n")).toMatch(/Agent "fe-member" has no runtime/);
  });

  it("rejects an effort level the runtime does not support", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace(feAgent, "  fe-member:\n    runtime: codex\n    effort: max\n    can_message"));
    expect(errors(env).join("\n")).toMatch(/effort "max" is not supported by codex/);

    env.editProjectYaml((t) => t.replace("effort: max", "effort: minimal").replace("runtime: codex", "runtime: claude-code"));
    expect(errors(env).join("\n")).toMatch(/effort "minimal" is not supported by claude-code/);
  });

  it("warns when runtime contradicts the model name", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace(feAgent, "  fe-member:\n    runtime: claude-code\n    model: gpt-5\n    can_message"));
    const res = validateProject(env.project());
    expect(res.ok).toBe(true);
    expect(res.issues.map((i) => i.message).join("\n")).toMatch(/model "gpt-5" looks like a codex model/);
  });
});

describe("validate fallback", () => {
  const setFallback = (env: TestEnv, line: string) =>
    env.editProjectYaml((t) => t.replace("  fe-member:\n    can_message: [lead]", `  fe-member:\n    fallback: ${line}\n    can_message: [lead]`));

  it("accepts a sound chain", () => {
    env = makeEnv();
    setFallback(env, "[{ model: haiku }, { runtime: codex, model: gpt-5, effort: high }]");
    expect(errors(env)).toEqual([]);
  });

  it("rejects an entry with neither model nor runtime", () => {
    env = makeEnv();
    setFallback(env, "[{ effort: high }]");
    expect(errors(env).join("\n")).toMatch(/agent fe-member: fallback #1 needs a model or a runtime/);
  });

  it("rejects an effort the entry's runtime does not accept", () => {
    env = makeEnv();
    setFallback(env, "[{ runtime: codex, model: gpt-5, effort: max }]");
    expect(errors(env).join("\n")).toMatch(/fallback codex\/gpt-5: effort "max" is not supported by codex/);
  });

  it("rejects an entry identical to the primary runtime and model", () => {
    env = makeEnv();
    const fe = env.project().agents["fe-member"];
    setFallback(env, `[{ runtime: ${fe.runtime}, model: ${fe.model ?? "sonnet"} }]`);
    if (!fe.model) env.editProjectYaml((t) => t.replace("    fallback:", "    model: sonnet\n    fallback:"));
    expect(errors(env).join("\n")).toMatch(/fallback .* is the same as the primary/);
  });

  it("rejects a fallback runtime that cannot enforce the agent's web level", async () => {
    const { RUNTIME_CAPS } = await import("../src/schema.js");
    env = makeEnv();
    setFallback(env, "[{ runtime: codex, model: gpt-5 }]");
    env.editProjectYaml((t) => t.replace("    fallback:", "    allow_web: search\n    fallback:"));
    const saved = RUNTIME_CAPS.codex.webLevels;
    RUNTIME_CAPS.codex.webLevels = ["none"];
    try {
      expect(errors(env).join("\n")).toMatch(/agent fe-member: fallback codex\/gpt-5 cannot enforce allow_web: search/);
    } finally {
      RUNTIME_CAPS.codex.webLevels = saved;
    }
  });
});

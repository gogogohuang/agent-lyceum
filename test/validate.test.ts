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

  it("requires at least 3 agents", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace(/  qa-member:[\s\S]*$/, ""));
    expect(errors(env).join("\n")).toMatch(/at least 3 agents/);
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

  it("max_parallel > 1 requires disjoint owns", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("max_parallel: 1", "max_parallel: 2"));
    expect(errors(env).join("\n")).toMatch(/requires "owns"/);

    env.editProjectYaml((t) =>
      t.replace("    # owns: [\"src/web/**\"]", '    owns: ["src/**"]').replace("    # owns: [\"tests/**\"]", '    owns: ["src/web/**"]'),
    );
    expect(errors(env).join("\n")).toMatch(/"owns" overlap/);

    env.editProjectYaml((t) => t.replace('owns: ["src/web/**"]', 'owns: ["tests/**"]'));
    expect(errors(env)).toEqual([]);
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
});

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGlobal, resolveProjectFrom } from "../src/config.js";
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

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeSettings } from "../src/adapters/claude.js";
import { buildCodexInvocation } from "../src/adapters/codex.js";
import { resolveCallAgent } from "../src/call.js";
import { ConfigError, flattenResolved, resolveProject, resolveProjectWithSources } from "../src/config.js";
import { soloProject } from "../src/solo.js";
import { makeEnv, write, type ClaudeSettingsView, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

/** `fe-member` of the template, with `lines` added to its project.yaml entry. */
const feMember = (e: TestEnv, lines: string) => e.editProjectYaml((t) => t.replace("  fe-member:\n    can_message: [lead]", `  fe-member:\n    can_message: [lead]\n${lines}`));

const claudeAllow = (e: TestEnv): string[] => {
  const p = e.project();
  return (buildClaudeSettings(p, p.agents["fe-member"]!) as unknown as ClaudeSettingsView).permissions.allow;
};

const codexArgs = (e: TestEnv): string[] => {
  const project = e.project();
  return buildCodexInvocation({ project, agent: project.agents["fe-member"]!, workDir: path.join(e.root, "work"), systemPrompt: "SYS", userPrompt: "USER", timeoutSec: 5 }).args;
};

describe("allow_web in the configuration", () => {
  it("is off unless somebody sets it", () => {
    env = makeEnv();
    const p = env.project();
    expect(p.agents["fe-member"]!.allowWeb).toBeUndefined();
    expect(flattenResolved(p)["agents.fe-member.allow_web"]).toBeUndefined();
  });

  it("is read from project.yaml, and the project value beats the global one", () => {
    env = makeEnv();
    const team = path.join(env.home, "team.yaml");
    fs.writeFileSync(team, fs.readFileSync(team, "utf8").replace("    memory: { global: agents/fe-member/memory }", "    memory: { global: agents/fe-member/memory }\n    allow_web: search"));
    expect(env.project().agents["fe-member"]!.allowWeb).toBe("search");
    feMember(env, "    allow_web: fetch");
    const { project, sources } = resolveProjectWithSources(env.home, "demo");
    expect(project.agents["fe-member"]!.allowWeb).toBe("fetch");
    expect(sources["agents.fe-member.allow_web"]).toEqual({ file: project.paths.config, key: "agents.fe-member.allow_web" });
    expect(flattenResolved(project)["agents.fe-member.allow_web"]).toBe("fetch");
  });

  it("rejects a value other than none, search and fetch, naming the field", () => {
    env = makeEnv();
    feMember(env, "    allow_web: everything");
    expect(() => resolveProject(env.home, "demo")).toThrow(ConfigError);
    expect(() => resolveProject(env.home, "demo")).toThrow(/allow_web/);
  });
});

describe("allow_web for Claude Code", () => {
  it("adds no web tool when it is not set, and none for `none`", () => {
    env = makeEnv();
    expect(claudeAllow(env)).not.toContain("WebSearch");
    expect(claudeAllow(env)).not.toContain("WebFetch");
    feMember(env, "    allow_web: none");
    expect(claudeAllow(env)).not.toContain("WebSearch");
    expect(claudeAllow(env)).not.toContain("WebFetch");
  });

  it("`search` allows WebSearch only", () => {
    env = makeEnv();
    feMember(env, "    allow_web: search");
    expect(claudeAllow(env)).toContain("WebSearch");
    expect(claudeAllow(env)).not.toContain("WebFetch");
  });

  it("`fetch` allows WebSearch and WebFetch", () => {
    env = makeEnv();
    feMember(env, "    allow_web: fetch");
    expect(claudeAllow(env)).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
  });
});

describe("allow_web for Codex", () => {
  const webSearchOf = (args: string[]): string | undefined => {
    const i = args.findIndex((a) => a.startsWith("web_search="));
    return i < 0 ? undefined : `${args[i - 1]} ${args[i]}`;
  };

  it("leaves Codex's own default alone when it is not set", () => {
    env = makeEnv();
    feMember(env, "    runtime: codex");
    expect(webSearchOf(codexArgs(env))).toBeUndefined();
  });

  it.each([
    ["none", 'web_search="disabled"'],
    ["search", 'web_search="cached"'],
    ["fetch", 'web_search="live"'],
  ])("maps %s to %s", (value, expected) => {
    env = makeEnv();
    feMember(env, `    runtime: codex\n    allow_web: ${value}`);
    expect(webSearchOf(codexArgs(env))).toBe(`-c ${expected}`);
  });

  it("also passes it when a session is resumed", () => {
    env = makeEnv();
    feMember(env, "    runtime: codex\n    allow_web: fetch");
    const project = env.project();
    const args = buildCodexInvocation({ project, agent: project.agents["fe-member"]!, workDir: path.join(env.root, "work"), systemPrompt: "SYS", userPrompt: "USER", timeoutSec: 5, sessionId: "s1" }).args;
    expect(webSearchOf(args)).toBe('-c web_search="live"');
  });
});

describe("allow_web in the single-agent entries", () => {
  it("is kept for a run --agent member", () => {
    env = makeEnv();
    feMember(env, "    allow_web: fetch");
    expect(soloProject(env.project(), "fe-member").agents["fe-member"]!.allowWeb).toBe("fetch");
  });

  it("is read from team.yaml for `call`", () => {
    env = makeEnv();
    write(path.join(env.home, "agents/pm/AGENT.md"), "# pm\n");
    fs.appendFileSync(path.join(env.home, "team.yaml"), "  pm:\n    runtime: claude-code\n    allow_web: fetch\n");
    expect(resolveCallAgent(env.home, "pm").allowWeb).toBe("fetch");
  });
});

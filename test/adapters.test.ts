import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeInvocation, buildClaudeSettings } from "../src/adapters/claude.js";
import { buildCodexInvocation, codexWritableRoots } from "../src/adapters/codex.js";
import { commonFile, repoInstructionFiles, writePolicy } from "../src/policy.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const input = (e: TestEnv, agent: string, extra = {}) => {
  const project = e.project();
  return {
    project,
    agent: project.agents[agent],
    workDir: path.join(e.root, "work", agent),
    systemPrompt: "SYS",
    userPrompt: "USER",
    timeoutSec: 5,
    ...extra,
  };
};

describe("write policy", () => {
  it("lets a normal agent write only its memory and outbox, and denies the protected files", () => {
    env = makeEnv();
    const p = env.project();
    const pol = writePolicy(p, p.agents["fe-member"]);
    expect(pol.allowDirs).toEqual([
      path.join(env.home, "agents/fe-member/memory"),
      path.join(p.paths.outboxRoot, "fe-member"),
    ]);
    expect(pol.allowFiles).toEqual([]);
    expect(pol.deny).toContain(p.agents["fe-member"].agentMd);
    expect(pol.deny).toContain(commonFile(p));
    for (const f of repoInstructionFiles(p)) expect(pol.deny).toContain(f);
    expect(pol.deny).toContain(path.join(env.home, "agents/qa-member/memory"));
    expect(pol.deny).toContain(p.paths.runs);
  });

  it("lets the lead edit COMMON.md, all AGENT.md files and the repo instruction files", () => {
    env = makeEnv();
    const p = env.project();
    const pol = writePolicy(p, p.agents.lead);
    expect(pol.allowFiles).toContain(commonFile(p));
    expect(pol.allowFiles).toContain(p.agents["qa-member"].agentMd);
    for (const f of repoInstructionFiles(p)) expect(pol.allowFiles).toContain(f);
    expect(pol.deny).not.toContain(commonFile(p));
    expect(pol.deny).not.toContain(p.agents["qa-member"].agentMd);
  });
});

describe("Claude Code adapter", () => {
  it("builds settings with Edit rules only (Write rules are ignored by Claude Code) and a sandbox", () => {
    env = makeEnv();
    const p = env.project();
    const s = buildClaudeSettings(p, p.agents["fe-member"]) as any;
    const all = [...s.permissions.allow, ...s.permissions.deny] as string[];
    expect(all.some((r) => r.startsWith("Write("))).toBe(false);
    expect(s.permissions.deny).toContain(`Edit(/${p.agents["fe-member"].agentMd})`);
    expect(s.permissions.allow).toContain(`Edit(/${env.repo}/**)`);
    expect(s.permissions.allow).toContain(`Edit(/${path.join(env.home, "agents/fe-member/memory")}/**)`);
    expect(s.sandbox.enabled).toBe(true);
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(s.sandbox.filesystem.denyWrite).toContain(p.agents["fe-member"].agentMd);
    expect(s.sandbox.filesystem.allowWrite).toContain(env.repo);
  });

  it("restricts repo edits to owned globs when running in parallel", () => {
    env = makeEnv();
    env.editProjectYaml((t) =>
      t
        .replace("max_parallel: 1", "max_parallel: 2")
        .replace('    # owns: ["src/web/**"]', '    owns: ["src/web/**"]')
        .replace('    # owns: ["tests/**"]', '    owns: ["tests/**"]'),
    );
    const p = env.project();
    const s = buildClaudeSettings(p, p.agents["fe-member"]) as any;
    expect(s.permissions.allow).toContain(`Edit(/${env.repo}/src/web/**)`);
    expect(s.permissions.allow).not.toContain(`Edit(/${env.repo}/**)`);
  });

  it("passes the prompt on stdin and system prompt via file, with add-dir for context paths", () => {
    env = makeEnv();
    const inv = buildClaudeInvocation(input(env, "fe-member", { sessionId: "sess-1" }));
    expect(inv.cmd).toBe("claude");
    expect(inv.stdin).toBe("USER");
    expect(inv.cwd).toBe(env.repo);
    expect(inv.args).toContain("--append-system-prompt-file");
    expect(inv.args).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk", "--resume", "sess-1"]));
    const i = inv.args.indexOf("--add-dir");
    expect(inv.args[i + 1]).toBe(path.join(env.home, "agents/fe-member/memory"));
    expect(inv.args.every((a) => a !== "USER")).toBe(true);
  });

  it("parses the json result", () => {
    env = makeEnv();
    const inv = buildClaudeInvocation(input(env, "lead"));
    const ok = inv.parse({ stdout: JSON.stringify({ result: "hi", session_id: "s9", usage: { output_tokens: 42 }, is_error: false }), stderr: "", code: 0 });
    expect(ok).toMatchObject({ ok: true, text: "hi", sessionId: "s9", outputTokens: 42 });
    expect(inv.parse({ stdout: JSON.stringify({ result: "boom", is_error: true }), stderr: "", code: 1 }).ok).toBe(false);
    expect(inv.parse({ stdout: "garbage", stderr: "x", code: 1 }).ok).toBe(false);
    // newer Claude Code versions print an array of events; the result is the "result" element
    const events = [
      { type: "system", subtype: "init", session_id: "s-init" },
      { type: "assistant", message: {} },
      { type: "result", subtype: "success", is_error: false, result: "from array", session_id: "s-arr", usage: { output_tokens: 7 } },
    ];
    expect(inv.parse({ stdout: JSON.stringify(events), stderr: "", code: 0 })).toMatchObject({ ok: true, text: "from array", sessionId: "s-arr", outputTokens: 7 });
    expect(inv.parse({ stdout: JSON.stringify([events[0]]), stderr: "e", code: 0 }).ok).toBe(false);
  });
});

describe("Codex adapter", () => {
  it("uses workspace-write with per-invocation writable_roots and the persona in the prompt", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("  fe-member:\n    can_message", "  fe-member:\n    runtime: codex\n    can_message"));
    const inv = buildCodexInvocation(input(env, "fe-member"));
    expect(inv.cmd).toBe("codex");
    expect(inv.args.slice(0, 5)).toEqual(["exec", "-C", env.repo, "-s", "workspace-write"]);
    expect(inv.args).toContain("--skip-git-repo-check");
    const roots = JSON.parse(inv.args[inv.args.findIndex((a) => a.startsWith("sandbox_workspace_write.writable_roots=")) ].split("=").slice(1).join("="));
    expect(roots).toEqual(codexWritableRoots(input(env, "fe-member")));
    expect(roots).toContain(path.join(env.home, "agents/fe-member/memory"));
    expect(roots).not.toContain(path.join(env.home, "agents/qa-member/memory"));
    expect(inv.stdin).toContain("SYS");
    expect(inv.stdin).toContain("USER");
  });

  it("builds a resume invocation", () => {
    env = makeEnv();
    const inv = buildCodexInvocation(input(env, "lead", { sessionId: "t-1" }));
    expect(inv.args.slice(0, 3)).toEqual(["exec", "resume", "t-1"]);
  });
});

describe("prompts", () => {
  it("system prompt carries persona, recipients and outbox path", () => {
    env = makeEnv();
    const p = env.project();
    const s = buildSystemPrompt(p, p.agents["fe-member"]);
    expect(s).toContain("# Frontend member");
    expect(s).toContain(path.join(p.paths.outboxRoot, "fe-member"));
    expect(s).toContain("You may send to: lead.");
    expect(s).not.toContain("| done");
    expect(buildSystemPrompt(p, p.agents.lead)).toContain("type: reply        # task | reply | done");
    expect(buildSystemPrompt(p, p.agents.lead)).toContain("## Result");
    expect(buildSystemPrompt(p, p.agents["fe-member"])).not.toContain("## Not done");
  });
});

describe("effort", () => {
  it("passes effort to claude as --effort and to codex as model_reasoning_effort", () => {
    env = makeEnv();
    const claude = input(env, "lead");
    claude.agent = { ...claude.agent, effort: "high" };
    const c = buildClaudeInvocation(claude);
    expect(c.args.slice(c.args.indexOf("--effort"), c.args.indexOf("--effort") + 2)).toEqual(["--effort", "high"]);

    const codex = input(env, "fe-member");
    codex.agent = { ...codex.agent, effort: "low" };
    expect(buildCodexInvocation(codex).args).toContain('model_reasoning_effort="low"');
  });

  it("omits the flag when effort is unset", () => {
    env = makeEnv();
    expect(buildClaudeInvocation(input(env, "lead")).args).not.toContain("--effort");
  });
});

describe("codexOutputTokens", () => {
  it("sums output_tokens over turn.completed events", async () => {
    const { codexOutputTokens } = await import("../src/adapters/codex.js");
    const out = ['{"type":"turn.completed","usage":{"output_tokens":5}}', "noise", '{"type":"turn.completed","usage":{"output_tokens":7}}'].join("\n");
    expect(codexOutputTokens(out)).toBe(12);
    expect(codexOutputTokens("nothing")).toBeUndefined();
  });
});

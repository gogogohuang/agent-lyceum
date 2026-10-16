import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaudeInvocation, buildClaudeSettings, classifyClaudeError, extractClaudeResult } from "../src/adapters/claude.js";
import { buildCodexInvocation, classifyCodexError, codexWritableRoots } from "../src/adapters/codex.js";
import { commonFile, repoInstructionFiles, writePolicy } from "../src/policy.js";
import { buildSoloSystemPrompt, buildSystemPrompt } from "../src/prompt.js";
import { soloProject } from "../src/solo.js";
import { makeEnv, type ClaudeSettingsView, type TestEnv } from "./helpers.js";

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
  it("denies a Claude agent the git pointers inside its own worktree, and leaves an agent without a worktree unchanged", () => {
    env = makeEnv();
    const p = env.project();
    const before = writePolicy(p, p.agents["fe-member"]).deny;
    const ws = {
      agent: "fe-member",
      root: path.join(env.root, "wt", "fe-member"),
      dir: path.join(env.root, "wt", "fe-member"),
      gitDir: path.join(env.root, "repo", ".git", "worktrees", "fe-member"),
      commonDir: path.join(env.root, "repo", ".git"),
      branch: "agent-lyceum/r/fe-member",
    };
    const wp = { ...p, workspaces: { "fe-member": ws } } as unknown as typeof p;
    const deny = writePolicy(wp, wp.agents["fe-member"]).deny;
    expect(deny).toEqual(
      expect.arrayContaining([
        path.join(ws.root, ".git"),
        path.join(ws.gitDir, "commondir"),
        path.join(ws.gitDir, "config.worktree"),
        path.join(ws.gitDir, "gitdir"),
      ]),
    );
    expect(before.some((d) => d.includes(".git"))).toBe(false);
    expect(writePolicy(wp, wp.agents["qa-member"]).deny).not.toContain(path.join(ws.gitDir, "commondir"));
  });

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
    const s = buildClaudeSettings(p, p.agents["fe-member"]) as unknown as ClaudeSettingsView;
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

  it("turns off the user's and plugins' hooks: nobody is there to answer a hook that asks a question, and it blocks every write", () => {
    env = makeEnv();
    const p = env.project();
    const s = buildClaudeSettings(p, p.agents["fe-member"]);
    expect(s.disableAllHooks).toBe(true);
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
    expect(buildSystemPrompt(p, p.agents.lead)).toContain("type: reply        # task | reply | ask | done");
    expect(buildSystemPrompt(p, p.agents.lead)).toContain("## Result");
    expect(buildSystemPrompt(p, p.agents["fe-member"])).not.toContain("## Not done");
  });

  it("tells every agent not to leave servers or daemons running", () => {
    env = makeEnv();
    const p = env.project();
    for (const a of Object.values(p.agents)) expect(buildSystemPrompt(p, a)).toContain("Never start a server, daemon or watcher");
  });

  it("tells every agent to sign PRs as opened by agent-lyceum without naming a role", () => {
    env = makeEnv();
    const p = env.project();
    for (const a of Object.values(p.agents)) {
      const s = buildSystemPrompt(p, a);
      expect(s).toContain("opened by agent-lyceum");
      expect(s).toContain("Do not name any agent or role");
    }
  });

  it("tells the lead when it may ask for a pull request, and keeps role names out of the report", () => {
    env = makeEnv();
    const p = env.project();
    const prompt = buildSystemPrompt(p, p.agents.lead);
    expect(prompt).toMatch(/open_pr: true/);
    expect(prompt).toMatch(/only when the user's task explicitly asks for a pull request/);
    expect(prompt).toMatch(/agent-lyceum \(not you\) then pushes the branch and opens the pull request/);
    expect(prompt).toMatch(/Keep agent and role names out of the report/);
    expect(buildSystemPrompt(p, p.agents["fe-member"])).not.toMatch(/open_pr/);
  });

  it("gives a solo agent the same rule", () => {
    env = makeEnv();
    const sp = soloProject(env.project(), "fe-member");
    const prompt = buildSoloSystemPrompt(sp, sp.agents["fe-member"]);
    expect(prompt).toMatch(/open_pr: true/);
    expect(prompt).toMatch(/only when the user's task explicitly asks for a pull request/);
  });

  it("does not mention open_pr to a call (no done mail there)", () => {
    env = makeEnv();
    const sp = { ...soloProject(env.project(), "fe-member"), solo: "call" as const };
    expect(buildSoloSystemPrompt(sp, sp.agents["fe-member"])).not.toMatch(/open_pr/);
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

describe("ask protocol in the system prompt", () => {
  it("explains ask to the lead and to members with can_ask_user, and to nobody else", () => {
    const env = makeEnv();
    try {
      env.editProjectYaml((t) => t.replace("  qa-member:\n    can_message: [lead]", "  qa-member:\n    can_message: [lead]\n    can_ask_user: true"));
      const p = env.project();
      const lead = buildSystemPrompt(p, p.agents.lead!);
      const fe = buildSystemPrompt(p, p.agents["fe-member"]!);
      const qa = buildSystemPrompt(p, p.agents["qa-member"]!);
      expect(lead).toContain("## Asking the user");
      expect(lead).toContain("<ask>");
      expect(lead).toMatch(/task \| reply \| ask \| done/);
      expect(qa).toContain("## Asking the user");
      expect(qa).toMatch(/task \| reply \| ask/);
      expect(fe).not.toContain("Asking the user");
      expect(fe).not.toContain("<ask>");
    } finally {
      env.cleanup();
    }
  });
});

// Samples marked "observed" were captured from the real CLIs (claude 2.x, codex-cli 0.162.1) with a bogus API key or an unreachable
// base URL. "documented" ones come from the CLIs' / APIs' documented error text and were not seen in a run log: kept conservative.
describe("classifyClaudeError", () => {
  const claudeJson = (status: number | null, result: string) => JSON.stringify({ is_error: true, api_error_status: status, result, type: "result" });
  const cases: [string, string, string, string][] = [
    // [rule, expected kind, stdout, source]
    ["auth: HTTP 401", "auth", claudeJson(401, "Invalid API key · Fix external API key"), "observed"],
    ["auth: not logged in", "auth", claudeJson(null, "Not logged in · Please run /login"), "documented"],
    ["quota: usage limit", "quota", claudeJson(null, "5-hour limit reached ∙ resets 3pm"), "documented"],
    ["quota: credit balance", "quota", claudeJson(400, "Credit balance is too low"), "documented"],
    ["rate_limit: HTTP 429", "rate_limit", claudeJson(429, "API Error: Request rejected (429)"), "documented"],
    ["rate_limit: overloaded", "rate_limit", claudeJson(529, "API Error: Overloaded"), "documented"],
    ["network: ECONNREFUSED", "network", claudeJson(null, "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)"), "observed"],
    ["network: ENOTFOUND", "network", claudeJson(null, "API Error: getaddrinfo ENOTFOUND api.anthropic.com"), "documented"],
    ["network: socket hang up", "network", claudeJson(null, "API Error: socket hang up"), "documented"],
    ["crash: heap out of memory", "crash", claudeJson(null, "FATAL ERROR: JavaScript heap out of memory"), "documented"],
  ];
  it.each(cases)("%s => %s (%s sample)", (_rule, kind, stdout) => {
    const j = JSON.parse(stdout) as { result: string };
    expect(classifyClaudeError({ code: 1, stdout, stderr: "", result: j.result })).toBe(kind);
  });
  it("crash: killed by a signal (exit code null) or a native crash message; documented, not observed", () => {
    expect(classifyClaudeError({ code: null, stdout: "", stderr: "" })).toBe("crash");
    expect(classifyClaudeError({ code: 139, stdout: "", stderr: "Segmentation fault: 11" })).toBe("crash");
  });
  it("a failure no rule recognizes is unknown, never crash", () => {
    expect(classifyClaudeError({ code: 1, stdout: "", stderr: "something nobody has seen before" })).toBe("unknown");
    expect(classifyClaudeError({ code: 3, stdout: "", stderr: "" })).toBe("unknown");
    expect(classifyClaudeError({ code: 1, stdout: claudeJson(null, "I could not finish the task"), stderr: "", result: "I could not finish the task" })).toBe("unknown");
  });
  it("reads result only from an is_error run: a normal answer mentioning rate limits is not a rate_limit", () => {
    const answer = '{"is_error":false,"result":"I added a rate limit (429) and an Invalid API key check","session_id":"s"}';
    expect(classifyClaudeError({ code: 1, stdout: answer, stderr: "" })).toBe("unknown");
    const err = '{"is_error":true,"result":"5-hour limit reached ∙ resets 3pm","session_id":"s"}';
    expect(classifyClaudeError({ code: 0, stdout: err, stderr: "" })).toBe("quota");
    env = makeEnv();
    const c = buildClaudeInvocation({ ...input(env, "lead", { runtime: "claude-code" }) });
    expect(c.parse({ stdout: answer, stderr: "", code: 1 })).toMatchObject({ ok: false, kind: "unknown" });
    expect(c.parse({ stdout: err, stderr: "", code: 0 })).toMatchObject({ ok: false, kind: "quota" });
  });
  it("a bare number or word is not enough: rules want a status-like context", () => {
    expect(classifyClaudeError({ code: 1, stdout: "", stderr: "retried 429 times, rate limiting is on, overloaded machine" })).toBe("unknown");
  });
  it("the first matching rule wins (a 5-hour limit is quota, not rate_limit)", () => {
    expect(classifyClaudeError({ code: 1, stdout: "", stderr: "5-hour limit reached ∙ rate limit" })).toBe("quota");
  });
});

describe("classifyCodexError", () => {
  const cases: [string, string, string, string][] = [
    ["auth: 401 / invalid_api_key", "auth", "unexpected status 401 Unauthorized: Incorrect API key provided: sk-bogus., url: https://api.openai.com/v1/responses, auth error: 401, auth error code: invalid_api_key", "observed"],
    ["auth: not logged in", "auth", "Not logged in. Run `codex login`", "documented"],
    ["quota: insufficient_quota", "quota", "unexpected status 429 Too Many Requests: You exceeded your current quota, error code: insufficient_quota", "documented"],
    ["quota: usage limit", "quota", "You've hit your usage limit. Upgrade to Pro or try again later.", "documented"],
    ["rate_limit: 429", "rate_limit", "exceeded retry limit, last status: 429 Too Many Requests", "documented"],
    ["rate_limit: rate_limit_exceeded", "rate_limit", "Rate limit reached for gpt-5 (rate_limit_exceeded)", "documented"],
    ["network: waiting for network", "network", "Reconnecting... waiting for network (Connection failed: error sending request)", "observed as a retry event only; final-failure sample documented"],
    ["crash: panicked at", "crash", "thread 'main' panicked at core/src/lib.rs:10:5", "documented"],
    ["network: ENOTFOUND", "network", "dns error: failed to lookup address (ENOTFOUND api.openai.com)", "documented"],
  ];
  it.each(cases)("%s => %s (%s sample)", (_rule, kind, text) => {
    expect(classifyCodexError({ code: 1, stdout: "", stderr: text })).toBe(kind);
    expect(classifyCodexError({ code: 1, stdout: JSON.stringify({ type: "turn.failed", error: { message: text } }), stderr: "" })).toBe(kind);
  });
  it("reads only error channels: command output or messages in stdout never classify a failure", () => {
    const stdout = '{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"429 rate limit unauthorized codex login"}}';
    expect(classifyCodexError({ code: 1, stdout, stderr: "" })).toBe("unknown");
    expect(classifyCodexError({ code: 1, stdout, stderr: "unexpected status 429 Too Many Requests" })).toBe("rate_limit");
  });
  it("a bare number or word is not enough: rules want a status-like context", () => {
    expect(classifyCodexError({ code: 1, stdout: "", stderr: "line 401 of the unauthorized.ts file, 429 items, rate limiting" })).toBe("unknown");
  });
  it("crash: killed by a signal; documented, not observed", () => {
    expect(classifyCodexError({ code: null, stdout: "", stderr: "" })).toBe("crash");
  });
  it("the final turn.failed message decides, not the reconnect noise before it", () => {
    const stdout = [
      '{"type":"error","message":"Reconnecting... waiting for network (Connection failed: error sending request)"}',
      '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: auth error code: invalid_api_key"}}',
    ].join("\n");
    expect(classifyCodexError({ code: 1, stdout, stderr: "" })).toBe("auth");
  });
  it("a failure no rule recognizes is unknown, never crash", () => {
    expect(classifyCodexError({ code: 1, stdout: "", stderr: "something nobody has seen before" })).toBe("unknown");
    expect(classifyCodexError({ code: 2, stdout: "", stderr: "" })).toBe("unknown");
  });
});

describe("Parsed.kind", () => {
  const inv = (runtime: "claude-code" | "codex") => {
    env = makeEnv();
    const p = env.project();
    return runtime === "codex"
      ? buildCodexInvocation({ project: p, agent: { ...p.agents.lead, runtime }, workDir: path.join(env.root, "w"), systemPrompt: "S", userPrompt: "U", timeoutSec: 5 })
      : buildClaudeInvocation({ project: p, agent: { ...p.agents.lead, runtime }, workDir: path.join(env.root, "w"), systemPrompt: "S", userPrompt: "U", timeoutSec: 5 });
  };
  it("is set on a failed Claude run (stream and parse) and absent on success", () => {
    const c = inv("claude-code");
    const bad = JSON.stringify({ is_error: true, api_error_status: 401, result: "Invalid API key · Fix external API key" });
    const s = c.stream!();
    s.line(bad);
    expect(s.finish({ code: 1, stdoutTail: bad, stderrTail: "" })).toMatchObject({ ok: false, kind: "auth" });
    expect(c.parse({ stdout: bad, stderr: "", code: 1 })).toMatchObject({ ok: false, kind: "auth" });
    expect(c.parse({ stdout: "garbage", stderr: "boom", code: 1 })).toMatchObject({ ok: false, kind: "unknown" });
    const good = c.parse({ stdout: '{"result":"ok","session_id":"s"}', stderr: "", code: 0 });
    expect(good.ok).toBe(true);
    expect(good.kind).toBeUndefined();
  });
  it("is set on a failed Codex run and absent on success", () => {
    const c = inv("codex");
    const out = '{"type":"turn.failed","error":{"message":"unexpected status 429 Too Many Requests"}}';
    expect(c.parse({ stdout: out, stderr: "", code: 1 })).toMatchObject({ ok: false, kind: "rate_limit" });
    expect(c.parse({ stdout: "", stderr: "weird", code: 1 })).toMatchObject({ ok: false, kind: "unknown" });
    const good = c.parse({ stdout: "", stderr: "", code: 0 });
    expect(good.ok).toBe(true);
    expect(good.kind).toBeUndefined();
  });
});

describe("fake runtimes: FAKE_FAIL", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "runtime");
  let tmp = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fakefail-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const run = (fixture: string, env: Record<string, string>) =>
    spawnSync(process.execPath, [path.join(dir, fixture), ...(fixture.includes("codex") ? ["exec", "-"] : ["-p"])], { input: "hi", encoding: "utf8", env: { ...process.env, AGENT_LYCEUM_AGENT: "lead", ...env }, timeout: 10_000 });
  /** What the adapter would do with this output: Claude's `result` comes from its JSON, when there is any. */
  const classify = (fixture: string, r: ReturnType<typeof run>) => {
    if (fixture.includes("codex")) return classifyCodexError({ code: r.status, stdout: r.stdout, stderr: r.stderr });
    const result = extractClaudeResult(r.stdout)?.result;
    return classifyClaudeError({ code: r.status, stdout: r.stdout, stderr: r.stderr, result });
  };

  describe.each(["fake-claude.mjs", "fake-codex.mjs"])("%s", (fixture) => {
    it.each(["rate_limit", "quota", "network", "auth", "unknown"] as const)("FAKE_FAIL=%s fails with a message its own classifier reads back as %s", (kind) => {
      const r = run(fixture, { FAKE_FAIL: kind });
      expect(r.status).not.toBe(0);
      expect(classify(fixture, r)).toBe(kind);
    });
    it("FAKE_FAIL=crash dies from a signal", () => {
      const r = run(fixture, { FAKE_FAIL: "crash" });
      expect(r.status).toBeNull();
      expect(classify(fixture, r)).toBe("crash");
    });
    it("FAKE_FAIL=<kind>:<n> fails the first n calls (counted in FAKE_FAIL_COUNT), then succeeds", () => {
      const env = { FAKE_FAIL: "rate_limit:2", FAKE_FAIL_COUNT: path.join(tmp, `${fixture}.count`) };
      expect([run(fixture, env).status, run(fixture, env).status]).toEqual([1, 1]);
      expect(run(fixture, env).status).toBe(0);
      expect(run(fixture, env).status).toBe(0);
    });
    it("FAKE_FAIL=<kind>:<n> without FAKE_FAIL_COUNT refuses loudly", () => {
      const r = run(fixture, { FAKE_FAIL: "rate_limit:2" });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/FAKE_FAIL_COUNT/);
    });
    it("FAKE_FAIL without a count fails every call", () => {
      expect(run(fixture, { FAKE_FAIL: "auth" }).status).toBe(1);
      expect(run(fixture, { FAKE_FAIL: "auth" }).status).toBe(1);
    });
  });

  it("a FAKE_SCRIPT entry can say fail: <kind>; other entries succeed as before", () => {
    const file = path.join(tmp, "script.json");
    fs.writeFileSync(file, JSON.stringify({ calls: [{ agent: "lead", fail: "quota" }, { agent: "lead", result: "fine" }] }));
    const first = run("fake-claude.mjs", { FAKE_SCRIPT: file });
    expect(first.status).toBe(1);
    expect(classify("fake-claude.mjs", first)).toBe("quota");
    const second = run("fake-claude.mjs", { FAKE_SCRIPT: file });
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ result: "fine" });
  });
});

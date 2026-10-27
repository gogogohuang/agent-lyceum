import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import { buildClaudeSettings } from "../src/adapters/claude.js";
import { buildCodexInvocation } from "../src/adapters/codex.js";
import { callAgent } from "../src/call.js";
import { ConfigError, flattenResolved } from "../src/config.js";
import { nextStep } from "../src/fallback.js";
import { enforcementFor, sandboxPathConflicts, setOsSandboxForTest, writePolicy } from "../src/policy.js";
import { invokeWithSandboxChecks } from "../src/sandbox-invocation.js";
import { validateProject } from "../src/validate.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => setOsSandboxForTest(true));
afterEach(() => {
  setOsSandboxForTest(undefined);
  env?.cleanup();
});

/** Adds a `sandbox:` block (given as YAML lines under the agent) to fe-member in the global team.yaml. */
function withSandbox(lines: string[], extra = ""): void {
  const f = path.join(env.home, "team.yaml");
  const body = lines.map((l) => `      ${l}`).join("\n");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("  fe-member:", `  fe-member:\n    sandbox:\n${body}${extra}`));
}
const err = (): string => {
  try {
    env.project();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("expected a ConfigError");
};
const wakeInput = (e: TestEnv, agentName = "fe-member", extra: Partial<WakeInput> = {}): WakeInput => {
  const project = e.project();
  return { project, agent: project.agents[agentName]!, workDir: path.join(e.root, "work"), systemPrompt: "S", userPrompt: "U", timeoutSec: 5, ...extra };
};

describe("sandbox config", () => {
  it("leaves output untouched without sandbox", () => {
    env = makeEnv();
    const p = env.project();
    const a = p.agents["fe-member"]!;
    expect(a.sandbox).toBeUndefined();
    expect(Object.keys(flattenResolved(p)).some((k) => k.includes("sandbox"))).toBe(false);
    const s = buildClaudeSettings(p, a) as { sandbox: Record<string, unknown> };
    expect(Object.keys(s.sandbox)).toEqual(["enabled", "allowUnsandboxedCommands", "filesystem"]);
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
    const codex = buildCodexInvocation({ ...wakeInput(env), workDir: path.join(env.root, "w1") });
    expect(codex.args.join(" ")).not.toContain("network_access");
  });

  it.each([
    [["net: [a.com]"], "agents.fe-member.sandbox: Unrecognized key"],
    [["network: ['https://x.com']"], "sandbox.network.0"],
    [["network: ['*']"], "sandbox.network.0"],
    [["network: ['1.2.3.4']"], "sandbox.network.0"],
    [["network: ['x.com:443']"], "sandbox.network.0"],
    [["write: [rel/dir]"], "sandbox.write.0"],
    [["write: ['/a/*']"], "sandbox.write.0"],
    [["unix_sockets: ['$TMPDIR/tsx']"], "sandbox.unix_sockets.0"],
    [["local_binding: yes-please"], "sandbox.local_binding"],
  ])("rejects %j", (lines, key) => {
    env = makeEnv();
    withSandbox(lines);
    expect(err()).toContain(key);
  });

  it("expands ~, normalizes, and drops an all-empty block", () => {
    env = makeEnv();
    withSandbox(["write: ['~/a', /x/../b/]", "network: [Registry.NPMJS.org]", "local_binding: true"]);
    const a = env.project().agents["fe-member"]!;
    expect(a.sandbox?.write).toEqual([path.join(process.env.HOME!, "a"), "/b"]);
    expect(a.sandbox?.network).toEqual(["registry.npmjs.org"]);
    env.cleanup();
    env = makeEnv();
    withSandbox(["write: []", "network: []", "local_binding: false", "unix_sockets: []"]);
    expect(env.project().agents["fe-member"]!.sandbox).toBeUndefined();
  });
});

describe("sandbox pure checks", () => {
  it("reports equal, inside and contains", () => {
    const r = sandboxPathConflicts(
      [{ key: "write", index: 0, path: "/h/x" }, { key: "write", index: 1, path: "/h" }, { key: "unix_sockets", index: 0, path: "/h" }, { key: "write", index: 2, path: "/other" }],
      [{ path: "/h", reason: "home" }],
    );
    expect(r.map((c) => [c.key, c.index, c.relation])).toEqual([["write", 0, "inside"], ["write", 1, "equal"], ["unix_sockets", 0, "equal"]]);
    expect(sandboxPathConflicts([{ key: "write", index: 0, path: "/" }], [{ path: "/h", reason: "home" }])[0]?.relation).toBe("contains");
  });

  it("stops on a config failure before any retry or fallback", () => {
    for (const legacy of [true, false]) expect(nextStep("config", 1, 3, true, legacy)).toBe("stop");
  });
});

describe("sandbox validate", () => {
  it("refuses write paths in or above protected places, accepts a harmless one", () => {
    env = makeEnv();
    withSandbox([`write: ['${env.home}', '${env.repo}/src', '${path.dirname(env.home)}', '${env.root}/ok']`]);
    const issues = validateProject(env.project()).issues.filter((i) => i.level === "error").map((i) => i.message);
    expect(issues.some((m) => m.includes("sandbox.write[0]"))).toBe(true);
    expect(issues.some((m) => m.includes("sandbox.write[1]"))).toBe(true);
    expect(issues.some((m) => m.includes("sandbox.write[2]") && m.includes("contains"))).toBe(true);
    expect(issues.some((m) => m.includes("sandbox.write[3]"))).toBe(false);
  });

  it("refuses a codex backup that is wider than a claude primary, allows the reverse", () => {
    env = makeEnv();
    withSandbox([`network: [a.com]`], "\n    fallback:\n      - runtime: codex");
    expect(validateProject(env.project()).issues.some((i) => i.level === "error" && i.message.includes("fallback codex") && i.message.includes("network"))).toBe(true);
    setOsSandboxForTest(false);
    expect(validateProject(env.project()).issues.some((i) => i.message.includes("more sandbox allowance"))).toBe(false);
  });
});

describe("sandbox adapters", () => {
  const settings = (e: TestEnv) => {
    const p = e.project();
    return buildClaudeSettings(p, p.agents["fe-member"]!) as { sandbox: { network?: Record<string, unknown>; filesystem: { allowWrite: string[] } } };
  };

  it("emits per-domain network, local binding, unix sockets and the write dir for Claude", () => {
    env = makeEnv();
    const w = path.join(env.root, "cache");
    withSandbox([`write: ['${w}']`, "network: [registry.npmjs.org]", "local_binding: true", `unix_sockets: ['${env.root}/sock']`]);
    const s = settings(env).sandbox;
    expect(s.network).toEqual({ allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true, allowUnixSockets: [fs.realpathSync(env.root) + "/sock"] });
    expect(s.filesystem.allowWrite).toContain(fs.realpathSync(env.root) + "/cache");
    const p = env.project();
    expect(buildClaudeSettings(p, p.agents["fe-member"]!, { policy: writePolicy(p, p.agents["fe-member"]!), cwd: env.root })).not.toHaveProperty("sandbox.network");
  });

  it("turns Codex network_access on for exec and resume, not for local_binding alone, not under an override", () => {
    env = makeEnv();
    withSandbox(["network: [a.com]"]);
    const base = { ...wakeInput(env), agent: { ...env.project().agents["fe-member"]!, runtime: "codex" as const } };
    const fresh = buildCodexInvocation({ ...base, workDir: path.join(env.root, "w1") }).args;
    const resumed = buildCodexInvocation({ ...base, workDir: path.join(env.root, "w2"), sessionId: "sid" }).args;
    for (const a of [fresh, resumed]) expect(a).toContain("sandbox_workspace_write.network_access=true");
    const over = buildCodexInvocation({ ...base, workDir: path.join(env.root, "w3"), policy: writePolicy(base.project, base.agent) }).args;
    expect(over.join(" ")).not.toContain("network_access");
    env.cleanup();
    env = makeEnv();
    withSandbox(["local_binding: true"]);
    const b = { ...wakeInput(env), agent: { ...env.project().agents["fe-member"]!, runtime: "codex" as const } };
    expect(buildCodexInvocation({ ...b, workDir: path.join(env.root, "w4") }).args.join(" ")).not.toContain("network_access");
  });

  it("explains in doctor notes, per runtime", () => {
    env = makeEnv();
    withSandbox(["network: [a.com]", "local_binding: true"]);
    const a = env.project().agents["fe-member"]!;
    const claude = enforcementFor(env.project(), a).notes.join("\n");
    expect(claude).toContain("claude-code: per-domain");
    const codex = enforcementFor(env.project(), { ...a, runtime: "codex" }).notes.join("\n");
    expect(codex).toContain("all-or-nothing");
    expect(codex).toContain("no Codex setting");
    setOsSandboxForTest(false);
    expect(enforcementFor(env.project(), a).notes.join("\n")).toContain("Edit tool rules only");
    expect(enforcementFor(env.project(), { ...a, runtime: "codex" }).notes.join("\n")).toContain("prompt-only");
  });
});

describe("sandbox invocation preflight", () => {
  const ok: WakeResult = { ok: true, text: "x", exitCode: 0, timedOut: false };

  it("records one sandbox event per attempt and calls the invoker", async () => {
    env = makeEnv();
    withSandbox([`write: ['${env.root}/ok']`, "network: [a.com]"]);
    const events: [string, Record<string, unknown>][] = [];
    let calls = 0;
    const inv: Invoker = async () => {
      calls++;
      return ok;
    };
    const input = wakeInput(env);
    const r = await invokeWithSandboxChecks(inv, input, input.agent, { event: (n, f) => events.push([n, f]) }, 2);
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]![0]).toBe("sandbox");
    expect(events[0]![1]).toMatchObject({ agent: "fe-member", attempt: 2, network: ["a.com"], applied: { write: "os", network: "domains", local_binding: "off", unix_sockets: "off" } });
  });

  it("refuses a protected path as a config failure without spawning, and writes no event for agents without sandbox", async () => {
    env = makeEnv();
    withSandbox([`write: ['${env.home}']`]);
    const events: string[] = [];
    let calls = 0;
    const inv: Invoker = async () => {
      calls++;
      return ok;
    };
    const input = wakeInput(env);
    const r = await invokeWithSandboxChecks(inv, input, input.agent, { event: (n) => events.push(n) }, 0);
    expect(r).toMatchObject({ ok: false, kind: "config" });
    expect(r.error).toContain("checked before invocation");
    expect(calls).toBe(0);
    expect(events).toEqual(["sandbox-refused"]);
    const other = wakeInput(env, "qa-member");
    await invokeWithSandboxChecks(inv, other, other.agent, { event: (n) => events.push(n) }, 0);
    expect(calls).toBe(1);
    expect(events).toEqual(["sandbox-refused"]);
  });

  it("call: one check, no spawn, no fallback, error names the reason", async () => {
    env = makeEnv();
    withSandbox([`write: ['${env.home}']`], "\n    fallback:\n      - runtime: codex");
    let calls = 0;
    const out: string[] = [];
    const r = await callAgent({ home: env.home, agent: "fe-member", task: "t", dir: env.repo, invoker: async () => {
      calls++;
      return ok;
    }, say: (s) => out.push(s) });
    expect(calls).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("sandbox refused");
    expect(r.tried).toHaveLength(1);
  });
});

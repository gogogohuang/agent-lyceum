import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realInvoker, type Invoker, type WakeInput, type WakeResult } from "../src/adapters/index.js";
import { ENROLLED_MCP_CONFIG, ENROLLED_SETTING_SOURCES, buildClaudeInvocation, buildClaudeSettings } from "../src/adapters/claude.js";
import { buildCodexInvocation } from "../src/adapters/codex.js";
import { ENROLLED_ENV_KEYS, runtimeEnv } from "../src/adapters/env.js";
import { ApprovalError } from "../src/approval-error.js";
import { callAgent, callProject, callsDir, resolveCallAgent } from "../src/call.js";
import type { ResolvedProject } from "../src/config.js";
import { runTeam } from "../src/dispatcher.js";
import { agentForCandidate, candidatesFor } from "../src/fallback.js";
import { deliver } from "../src/mailbox.js";
import { tidyMemory } from "../src/memory-tidy.js";
import { outboxDir, scratchCwd, type WritePolicy } from "../src/policy.js";
import { bindRunProject, loadRunState, newRunState, saveRunState } from "../src/run-store.js";
import { soloProject } from "../src/solo.js";
import { prepareTask } from "../src/task.js";
import { FULL_DONE, makeEnv, makeMemoryEnv, write, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeReport = path.join(here, "fixtures", "runtime", "fake-claude-report.mjs");
const SECRET = "executor-env-sentinel-secret";
const HOSTSECRET = "host-secret-value";
let env: TestEnv;
afterEach(() => {
  env?.cleanup();
  vi.unstubAllEnvs();
});

const EXEC = (allow: string): string =>
  `executors:\n  x:\n    command: ["/opt/x/tool"]\n    allow: ${allow}\n    timeout_sec: 5\n    env:\n      TOKEN: ${SECRET}\nlimits:\n  max_scan_entries: 80\n`;
const pin = (): void => {
  vi.stubEnv("PATH", "/usr/bin:/bin");
  vi.stubEnv("HOME", path.join(env.root, "user"));
  vi.stubEnv("LANG", "C.UTF-8");
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("TMPDIR", path.join(env.root, "tmp"));
  vi.stubEnv("USER", "fixture-user");
  vi.stubEnv("AGENT_LYCEUM_AGENT", "stale");
  vi.stubEnv("SOME_API_TOKEN", HOSTSECRET);
};
const enrolledEnv = (allow = "[{project: demo, agent: fe-member}, {project: demo, agent: lead}, {call: fe-member}]", make = makeEnv): ResolvedProject => {
  env = make();
  fs.writeFileSync(path.join(env.home, "executors.yaml"), EXEC(allow));
  pin();
  return env.project();
};
const bound = (p: ResolvedProject): ResolvedProject => bindRunProject(p, path.join(p.paths.runs, "fixture-run"), "run");
const wake = (p: ResolvedProject, name: string, extra: Partial<WakeInput> = {}): WakeInput => ({
  project: p, agent: p.agents[name]!, workDir: path.join(env.root, "work", name), systemPrompt: "SYS", userPrompt: "USER", timeoutSec: 5, ...extra,
});
const whitelist = (): Record<string, string> => Object.fromEntries(ENROLLED_ENV_KEYS.map((k) => [k, process.env[k]!]));
const flags = ["--strict-mcp-config", "--mcp-config", ENROLLED_MCP_CONFIG, "--setting-sources", ENROLLED_SETTING_SOURCES];
const hasFlags = (args: string[]): boolean => { const i = args.indexOf("--strict-mcp-config"); return i >= 0 && flags.every((f, k) => args[i + k] === f); };
type SettingsView = { disableAllHooks: boolean; permissions: { deny: string[] }; sandbox: Record<string, unknown> & { filesystem: { denyWrite: string[] } } };
const settingsOf = (workDir: string): SettingsView => JSON.parse(fs.readFileSync(path.join(workDir, "claude-settings.json"), "utf8"));
const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };

describe("B3 env whitelist (pure)", () => {
  it("enrolled: exactly the present whitelist keys, empty strings kept, nothing added or inherited", () => {
    const src = { PATH: "/p", HOME: "/h", LANG: "l", TERM: "", TMPDIR: "/t", USER: "u", SECRET: "x", AGENT_LYCEUM_AGENT: "old", FAKE_X: "1" };
    expect(runtimeEnv({ name: "a", enrolled: true }, src)).toEqual({ PATH: "/p", HOME: "/h", LANG: "l", TERM: "", TMPDIR: "/t", USER: "u" });
    expect(runtimeEnv({ name: "a", enrolled: true }, { PATH: "/p", SECRET: "x" })).toEqual({ PATH: "/p" });
    expect(Object.keys(runtimeEnv({ name: "a", enrolled: true }, {}))).toEqual([]);
    expect([...ENROLLED_ENV_KEYS]).toEqual(["PATH", "HOME", "LANG", "TERM", "TMPDIR", "USER"]);
  });
  it("not enrolled: the old environment plus the identity, unchanged", () => {
    const src = { PATH: "/p", SECRET: "x" };
    expect(runtimeEnv({ name: "a" }, src)).toEqual({ ...src, AGENT_LYCEUM_AGENT: "a" });
    expect(runtimeEnv({ name: "a", enrolled: false }, src)).toEqual({ ...src, AGENT_LYCEUM_AGENT: "a" });
  });
});

describe("B1 Claude hardening, enrolled only", () => {
  it("adds the flags, failIfUnavailable next to enabled, keeps hooks off and allowUnsandboxedCommands false", () => {
    const p = bound(enrolledEnv());
    const inv = buildClaudeInvocation(wake(p, "fe-member"));
    expect(hasFlags(inv.args)).toBe(true);
    expect(ENROLLED_SETTING_SOURCES).toBe("user");
    const s = settingsOf(path.join(env.root, "work", "fe-member"));
    expect(s.disableAllHooks).toBe(true);
    expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(Object.keys(s.sandbox).slice(0, 3)).toEqual(["enabled", "failIfUnavailable", "allowUnsandboxedCommands"]);
  });

  it("non-enrolled agents of the same project get none of it", () => {
    const p = bound(enrolledEnv());
    const inv = buildClaudeInvocation(wake(p, "qa-member"));
    expect(inv.args).not.toContain("--strict-mcp-config");
    expect(inv.args).not.toContain("--setting-sources");
    expect(settingsOf(path.join(env.root, "work", "qa-member")).sandbox).not.toHaveProperty("failIfUnavailable");
    expect(inv.env.AGENT_LYCEUM_AGENT).toBe("qa-member");
    expect(inv.env.SOME_API_TOKEN).toBe(HOSTSECRET);
  });

  it("buildClaudeSettings called directly (and with an override with deny: []) still carries failIfUnavailable and the approval denies", () => {
    const p = bound(enrolledEnv());
    fs.mkdirSync(path.join(env.home, "requests", "projects", "demo", "r1", "qa-member"), { recursive: true });
    const agent = p.agents["fe-member"]!;
    const direct = buildClaudeSettings(p, agent) as unknown as SettingsView;
    expect(direct.sandbox.failIfUnavailable).toBe(true);
    const override: WritePolicy = { allowDirs: [], readDirs: [], allowFiles: [], deny: [] };
    const s = buildClaudeSettings(p, agent, { policy: override, cwd: path.join(env.root, "scratch") }) as unknown as SettingsView;
    expect(s.sandbox.failIfUnavailable).toBe(true);
    const items = [path.join(env.home, "approvals"), path.join(env.home, "executors.yaml"), "/opt/x/tool", path.join(env.home, "requests", "projects", "demo", "r1", "qa-member")];
    for (const d of items) {
      expect(s.sandbox.filesystem.denyWrite, d).toContain(d);
      expect(s.permissions.deny, d).toContain(`Edit(/${d})`);
    }
    expect(s.sandbox.filesystem.denyWrite).not.toContain(path.join(env.home, "requests"));
    // a hand-built enrolled agent without the approval context cannot be built: it must not silently skip the denies
    expect(() => buildClaudeSettings(p, { ...agent, approval: undefined, enrolled: true })).toThrow(ApprovalError);
  });
});

describe("B2 strict inventory before any file", () => {
  it("an unavailable inventory throws the safe ApprovalError and creates nothing", () => {
    const p = bound(enrolledEnv());
    fs.mkdirSync(path.join(env.root, "elsewhere"));
    fs.symlinkSync(path.join(env.root, "elsewhere"), path.join(env.home, "requests"));
    const w = wake(p, "fe-member");
    expect(() => buildClaudeInvocation(w)).toThrow(ApprovalError);
    expect(fs.existsSync(w.workDir)).toBe(false);
    const pol = wake(p, "fe-member", { policy: { allowDirs: [], readDirs: [], allowFiles: [], deny: [] } });
    expect(() => buildClaudeInvocation(pol)).toThrow(ApprovalError);
    expect(fs.existsSync(pol.workDir)).toBe(false);
    try { buildClaudeInvocation(w); } catch (e) { expect((e as Error).message).not.toContain(SECRET); }
  });
});

describe("B3 env in the built invocation", () => {
  it("Claude enrolled: env is exactly the whitelist; no identity, no inherited secret", () => {
    const p = bound(enrolledEnv());
    const inv = buildClaudeInvocation(wake(p, "fe-member"));
    expect(inv.env).toEqual(whitelist());
    expect(inv.env).not.toHaveProperty("AGENT_LYCEUM_AGENT");
    expect(JSON.stringify(inv.env)).not.toContain(HOSTSECRET);
  });
});

describe("B4 Codex refuses enrolled agents before touching the disk", () => {
  it("throws, also with a policy override, and creates no file or directory", () => {
    const p = bound(enrolledEnv());
    for (const extra of [{}, { policy: { allowDirs: [], readDirs: [], allowFiles: [], deny: [] } }]) {
      const w = wake(p, "fe-member", extra);
      expect(() => buildCodexInvocation(w)).toThrow(/Approval-enrolled agent cannot use Codex: fe-member/);
      expect(() => buildCodexInvocation(w)).toThrow(ApprovalError);
      expect(fs.existsSync(w.workDir)).toBe(false);
      expect(fs.existsSync(scratchCwd(w.workDir))).toBe(false);
    }
  });
  it("a non-enrolled agent still builds, with the old env shape", () => {
    const p = bound(enrolledEnv());
    const inv = buildCodexInvocation(wake(p, "qa-member"));
    expect(inv.env.AGENT_LYCEUM_AGENT).toBe("qa-member");
    expect(inv.env.SOME_API_TOKEN).toBe(HOSTSECRET);
  });
});

describe("B5 every entry gets the same treatment", () => {
  it("resume (sessionId) and a policy wake keep the flags and the whitelist env", () => {
    const p = bound(enrolledEnv());
    const resumed = buildClaudeInvocation(wake(p, "fe-member", { sessionId: "sess-1" }));
    expect(resumed.args).toContain("--resume");
    expect(hasFlags(resumed.args)).toBe(true);
    expect(resumed.env).toEqual(whitelist());
    const pol: WritePolicy = { allowDirs: [path.join(env.root, "memdir")], readDirs: [], allowFiles: [], deny: [] };
    const tidy = buildClaudeInvocation(wake(p, "fe-member", { policy: pol }));
    expect(hasFlags(tidy.args)).toBe(true);
    expect(tidy.env).toEqual(whitelist());
    expect(settingsOf(path.join(env.root, "work", "fe-member")).sandbox.failIfUnavailable).toBe(true);
  });

  it("fallback: claude -> claude keeps the flags; claude -> codex is refused; a tier change keeps them", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("dispatcher:\n", "dispatcher:\n  fallback: [{runtime: claude-code, model: backup-model}, {runtime: codex, model: other}]\n"));
    fs.writeFileSync(path.join(env.home, "executors.yaml"), EXEC("[{project: demo, agent: fe-member}]"));
    pin();
    const p = bound(env.project());
    const agent = p.agents["fe-member"]!;
    const cands = candidatesFor(agent, "tier-model");
    expect(cands.map((c) => `${c.runtime}/${c.model ?? ""}`)).toEqual(expect.arrayContaining(["claude-code/tier-model", "claude-code/backup-model", "codex/other"]));
    for (const c of cands) {
      const moved = agentForCandidate(agent, c);
      expect(moved.enrolled, c.key).toBe(true);
      const w = wake(p, "fe-member", { agent: moved });
      if (c.runtime === "codex") expect(() => buildCodexInvocation(w)).toThrow(ApprovalError);
      else {
        const inv = buildClaudeInvocation(w);
        expect(hasFlags(inv.args), c.key).toBe(true);
        expect(inv.env).toEqual(whitelist());
        if (c.model) expect(inv.args).toContain(c.model);
      }
    }
  });

  it("solo and call build with the flags and the whitelist env", () => {
    const p = bound(enrolledEnv());
    const solo = soloProject(p, "fe-member");
    const si = buildClaudeInvocation(wake(solo, "fe-member"));
    expect(hasFlags(si.args)).toBe(true);
    expect(si.env).toEqual(whitelist());
    const agent = resolveCallAgent(env.home, "fe-member");
    expect(agent.enrolled).toBe(true);
    const cp = callProject(env.home, agent, env.repo, path.join(callsDir(env.home), "fixture-call"));
    const ci = buildClaudeInvocation({ ...wake(cp, "fe-member"), workDir: path.join(env.root, "work", "call") });
    expect(hasFlags(ci.args)).toBe(true);
    expect(ci.env).toEqual(whitelist());
  });

  it("the WakeInput that reaches the invoker carries enrolled: run (lead), solo, resume, call and tidy", async () => {
    const seen: Record<string, WakeInput[]> = {};
    const record = (key: string): Invoker => async (i) => { seen[key] = [...(seen[key] ?? []), i]; if (key !== "resume" && key !== "tidy") write(path.join(outboxDir(i.project, i.agent.name), "d.md"), `---\nto: ${i.agent.name}\ntype: done\nsubject: s\noutcome: completed\n---\n\n${FULL_DONE}\n`); return OK; };
    let p0 = enrolledEnv();
    // The per-wake approval gate (stage 2b-2) refuses an enrolled agent whose executor cannot be verified: give the fixture a real one.
    const realTool = path.join(env.root, "bin", "tool");
    write(realTool, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(realTool, 0o755);
    fs.writeFileSync(path.join(env.home, "executors.yaml"), fs.readFileSync(path.join(env.home, "executors.yaml"), "utf8").replace("/opt/x/tool", realTool));
    p0 = env.project();
    const approvalPremise = { platform: "linux" as const, sandboxAvailable: () => true };
    // run
    const runDir = path.join(p0.paths.runs, "run-a");
    await runTeam({ project: p0, task: prepareTask({ text: "t", cwd: env.root, runDir }), runDir, invoker: record("run"), log: () => {}, approvalPremise });
    expect(seen.run![0]!.agent).toMatchObject({ name: "lead", enrolled: true });
    expect(seen.run![0]!.agent.approval).toBeDefined();
    // solo
    const soloDir = path.join(p0.paths.runs, "run-solo");
    await runTeam({ project: p0, task: prepareTask({ text: "t", cwd: env.root, runDir: soloDir }), runDir: soloDir, soloAgent: "fe-member", invoker: record("solo"), log: () => {}, approvalPremise });
    expect(seen.solo![0]!.agent.enrolled).toBe(true);
    // resume: a waiting task and a stored session
    const resDir = path.join(p0.paths.runs, "run-res");
    fs.mkdirSync(resDir, { recursive: true });
    const rp = { ...p0, agents: { ...p0.agents, "fe-member": { ...p0.agents["fe-member"]!, resume: true } } };
    deliver(bindRunProject(rp, resDir, "run"), { from: "lead", to: "fe-member", type: "task", subject: "job", body: "x" });
    saveRunState(resDir, { ...newRunState({ run_id: "run-res", project: "demo", max_rounds: 3, rounds: 1, pid: 1, task_summary: "t" }), sessions: { "fe-member": "sess-9" } });
    await runTeam({ project: rp, resume: loadRunState(resDir), runDir: resDir, invoker: record("resume"), log: () => {}, sleep: async () => {}, approvalPremise });
    const first = seen.resume!.find((i) => i.agent.name === "fe-member")!;
    expect(first.agent.enrolled).toBe(true);
    // call
    await callAgent({ home: env.home, agent: "fe-member", task: "t", dir: env.repo, invoker: record("call"), say: () => {}, approvalPremise });
    expect(seen.call![0]!.agent.enrolled).toBe(true);
  });

  it("tidy: the invoker gets the enrolled agent with a policy", async () => {
    enrolledEnv("[{project: demo, agent: lead}]", makeMemoryEnv);
    seedMemory();
    const seen: WakeInput[] = [];
    const inv: Invoker = async (i) => { seen.push(i); return { ok: false, text: "", exitCode: 1, timedOut: false, error: "stop" }; };
    await tidyMemory({ project: env.project(), layer: "project", agent: "lead", invoker: inv, say: () => {} });
    expect(seen[0]!.agent.enrolled).toBe(true);
    expect(seen[0]!.policy).toBeDefined();
  });
});

const memOf = (agent: string): string => env.project().agents[agent]!.memory.project!;
function seedMemory(): void {
  for (const a of ["lead", "fe-member"]) {
    write(path.join(memOf(a), "MEMORY.md"), "- [a](a.md)\n");
    write(path.join(memOf(a), "a.md"), `alpha ${a}`);
  }
}
const listing = (dir: string): string[] => fs.readdirSync(dir, { recursive: true }).map(String).sort();

describe("B6 tidy: a failure after the snapshot is a failed job, not an abort", () => {
  it("a builder that throws synchronously: job failed, memory restored, snapshot gone, the next job still runs", async () => {
    enrolledEnv("[]", makeMemoryEnv);
    seedMemory();
    const before = { lead: listing(memOf("lead")), fe: listing(memOf("fe-member")) };
    const calls: string[] = [];
    const inv = ((i: WakeInput) => {
      calls.push(i.agent.name);
      if (i.agent.name === "lead") { fs.writeFileSync(path.join(memOf("lead"), "junk.md"), "x"); throw new Error("builder exploded"); }
      return Promise.resolve({ ok: false, text: "", exitCode: 1, timedOut: false, error: "stop" } as WakeResult);
    }) as Invoker;
    const res = await tidyMemory({ project: env.project(), layer: "project", invoker: inv, say: () => {} });
    expect(calls).toEqual(["lead", "fe-member"]);
    expect(res.map((r) => [r.agent, r.status])).toEqual([["lead", "failed"], ["fe-member", "failed"], ["qa-member", "skipped"]]);
    expect(res[0]!.problems.join(" ")).toContain("builder exploded");
    expect(listing(memOf("lead"))).toEqual(before.lead);
    expect(listing(memOf("fe-member"))).toEqual(before.fe);
    const work = path.join(env.project().paths.root, "task-memory");
    const snaps = fs.existsSync(work) ? (fs.readdirSync(work, { recursive: true }) as string[]).filter((f) => String(f).endsWith("snapshot")) : [];
    expect(snaps).toEqual([]);
  });

  it("an enrolled agent whose request inventory is unavailable: failed with the safe error, nothing spawned, the next job runs", async () => {
    enrolledEnv("[{project: demo, agent: lead}]", makeMemoryEnv);
    seedMemory();
    fs.mkdirSync(path.join(env.root, "elsewhere"));
    fs.symlinkSync(path.join(env.root, "elsewhere"), path.join(env.home, "requests"));
    const bin = path.join(env.root, "bin");
    const marker = path.join(env.root, "spawned");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
    const before = listing(memOf("lead"));
    const calls: string[] = [];
    const inv: Invoker = async (i) => {
      calls.push(i.agent.name);
      if (i.agent.name === "lead") return realInvoker(i);
      return { ok: false, text: "", exitCode: 1, timedOut: false, error: "stop" };
    };
    const res = await tidyMemory({ project: env.project(), layer: "project", invoker: inv, say: () => {} });
    expect(calls).toEqual(["lead", "fe-member"]);
    expect(res[0]!.status).toBe("failed");
    expect(res[0]!.problems.join(" ")).toMatch(/not a real directory|request/i);
    expect(res[0]!.problems.join(" ")).not.toContain(SECRET);
    expect(fs.existsSync(marker)).toBe(false);
    expect(listing(memOf("lead"))).toEqual(before);
    expect(res[1]!.agent).toBe("fe-member");
  });
});

describe("B7 a real fake child reports what an enrolled Claude invocation gives it", () => {
  it("received env equals the whitelist exactly and the flags are in its argv", () => {
    const p = bound(enrolledEnv());
    const inv = buildClaudeInvocation(wake(p, "fe-member"));
    const r = spawnSync(process.execPath, [fakeReport, ...inv.args], { input: inv.stdin, encoding: "utf8", env: inv.env, cwd: inv.cwd });
    expect(r.status).toBe(0);
    const rep = JSON.parse(JSON.parse(r.stdout).result);
    const got = Object.fromEntries(Object.entries(rep.env as Record<string, string>).filter(([k]) => k !== "__CF_USER_TEXT_ENCODING")); // macOS adds this one to every exec'd process (env -i check)
    expect(got).toEqual(whitelist());
    expect(hasFlags(rep.args)).toBe(true);
    expect(JSON.parse(rep.settings).sandbox.failIfUnavailable).toBe(true);
  });
});

describe("B8 executor env secrets never leave the config", () => {
  it("not in args, settings, env, prompts, stdin or errors", () => {
    const p = bound(enrolledEnv());
    const w = wake(p, "fe-member");
    const inv = buildClaudeInvocation(w);
    const settings = fs.readFileSync(path.join(w.workDir, "claude-settings.json"), "utf8");
    expect(JSON.stringify([inv.args, inv.env, inv.stdin, settings, p.agents["fe-member"]])).not.toContain(SECRET);
    for (const f of [() => buildCodexInvocation(w), () => buildClaudeSettings(p, { ...p.agents["fe-member"]!, approval: undefined })]) {
      try { f(); } catch (e) { expect(String(e)).not.toContain(SECRET); }
    }
  });
});

describe("stage 3: the request directory of a claim wake", () => {
  const dir = (): string => path.join(env.root, "req", "proposals");
  it("is one more writable directory (settings and --add-dir) only when the wake names it; without it the settings are unchanged", () => {
    const p = bound(enrolledEnv());
    const plain = wake(p, "fe-member");
    buildClaudeInvocation(plain);
    const before = fs.readFileSync(path.join(plain.workDir, "claude-settings.json"), "utf8");
    const granted = wake(p, "fe-member", { workDir: path.join(env.root, "work", "granted"), requestDir: dir() });
    const inv = buildClaudeInvocation(granted);
    const s = JSON.parse(fs.readFileSync(path.join(granted.workDir, "claude-settings.json"), "utf8"));
    expect(s.permissions.allow).toContain(`Edit(/${dir()}/**)`);
    expect(s.sandbox.filesystem.allowWrite).toContain(dir());
    expect(inv.args.join("\n")).toContain(`--add-dir\n${dir()}`);
    expect(buildClaudeSettings(p, p.agents["fe-member"]!)).toEqual(JSON.parse(before));
    expect(JSON.stringify(buildClaudeSettings(p, p.agents["fe-member"]!, undefined, dir()))).toContain(dir());
    // the grant never loosens a deny
    expect(s.sandbox.filesystem.denyWrite).toEqual(JSON.parse(before).sandbox.filesystem.denyWrite);
  });

  it("is never combined with a policy override (tidy, verify, format keep their minimal authority)", () => {
    const p = bound(enrolledEnv());
    const policy: WritePolicy = { allowDirs: [path.join(env.root, "only")], readDirs: [], allowFiles: [], deny: [] };
    const w = wake(p, "fe-member", { policy, requestDir: dir() });
    buildClaudeInvocation(w);
    const s = JSON.parse(fs.readFileSync(path.join(w.workDir, "claude-settings.json"), "utf8"));
    expect(JSON.stringify(s)).not.toContain(dir());
  });
});

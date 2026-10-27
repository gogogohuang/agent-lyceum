import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaudeSettings } from "../src/adapters/claude.js";
import { buildCodexInvocation } from "../src/adapters/codex.js";
import { setOsSandboxForTest } from "../src/policy.js";
import { invokeWithSandboxChecks } from "../src/sandbox-invocation.js";
import { buildStatusReport } from "../src/status.js";
import { newRunState, saveRunState } from "../src/run-store.js";
import { formatEnforcement, validateProject } from "../src/validate.js";
import { initGitRepo, makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => setOsSandboxForTest(true));
afterEach(() => {
  setOsSandboxForTest(undefined);
  env?.cleanup();
});

/** Rewrites fe-member in the global team.yaml: a runtime, a `sandbox:` block and optionally a `fallback:` entry. */
function member(opts: { runtime?: string; sandbox?: string[]; fallback?: string }): void {
  const f = path.join(env.home, "team.yaml");
  const lines = [
    ...(opts.sandbox ? ["    sandbox:", ...opts.sandbox.map((l) => `      ${l}`)] : []),
    ...(opts.fallback ? ["    fallback:", `      - runtime: ${opts.fallback}`] : []),
  ];
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("  fe-member:\n    runtime: claude-code\n", `  fe-member:\n    runtime: ${opts.runtime ?? "claude-code"}\n${lines.join("\n")}${lines.length ? "\n" : ""}`));
}
const errors = (): string[] => validateProject(env.project()).issues.filter((i) => i.level === "error").map((i) => i.message);

describe("fallback capability parity (spec 25.9)", () => {
  it("refuses a claude backup for a codex primary with local_binding, allows the opposite direction", () => {
    // Claude only applies local_binding on macOS, so on other hosts the backup reaches no more than the primary.
    const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      env = makeEnv();
      member({ runtime: "codex", sandbox: ["local_binding: true"], fallback: "claude-code" });
      expect(errors().some((m) => m.includes("fallback claude-code") && m.includes("local_binding"))).toBe(true);
      env.cleanup();
      env = makeEnv();
      member({ runtime: "claude-code", sandbox: ["local_binding: true"], fallback: "codex" });
      expect(errors().filter((m) => m.includes("more sandbox allowance"))).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("still reports the existing write-protection fallback check (no sandbox block involved)", () => {
    env = makeEnv();
    member({ runtime: "claude-code", fallback: "codex" });
    setOsSandboxForTest(false); // Claude keeps Edit rules, Codex falls to prompt-only
    const e = errors();
    expect(e.some((m) => m.includes("fallback codex/(default model) cannot enforce") && m.includes("-> prompt-only"))).toBe(true);
    expect(e.filter((m) => m.includes("more sandbox allowance"))).toEqual([]);
  });
});

describe("doctor: sandbox allowances per agent", () => {
  const report = (): string => {
    const v = validateProject(env.project());
    return formatEnforcement(v.enforcement);
  };

  it("lists the widened allowances per agent with the Codex limits", () => {
    env = makeEnv();
    member({ runtime: "codex", sandbox: ["network: [a.com]", "local_binding: true", `unix_sockets: ['${path.join(os_tmp(), "s.sock")}']`] });
    const out = report();
    expect(out).toContain("[fe-member] network: a.com (codex: all hosts)");
    expect(out).toContain("sandbox.network is all-or-nothing on Codex");
    expect(out).toContain("local_binding: requested, not supported by codex");
    expect(out).toContain("not applied by codex");
    const other = out.split("\n").filter((l) => l.startsWith("  [qa-member]") && l.includes("sandbox"));
    expect(other).toEqual([]); // an agent without sandbox lists nothing
  });

  it("says per runtime what happens without an OS sandbox", () => {
    env = makeEnv();
    member({ runtime: "claude-code", sandbox: ["network: [a.com]"] });
    setOsSandboxForTest(false);
    expect(report()).toContain("sandbox.write changes Edit tool rules only");
    env.cleanup();
    env = makeEnv();
    member({ runtime: "codex", sandbox: ["network: [a.com]"] });
    expect(report()).toContain("no OS sandbox; enforcement is prompt-only");
  });
});
const os_tmp = (): string => fs.realpathSync(env.root);

describe("git common dir probe fails closed (spec 25.19.4)", () => {
  const okResult = { ok: true, text: "", exitCode: 0, timedOut: false };
  const input = () => {
    const project = env.project();
    return { project, agent: project.agents["fe-member"]!, workDir: env.repo, systemPrompt: "S", userPrompt: "U", timeoutSec: 5 };
  };
  const sandboxOn = (): void => {
    env.project().agents["fe-member"]!.sandbox = { write: [path.join(env.root, "ok")], network: [], localBinding: false, unixSockets: [] };
  };

  it("refuses with kind config when the repo is a git checkout but `git rev-parse` fails", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    fs.writeFileSync(path.join(env.repo, ".git", "HEAD"), "garbage\n"); // git no longer recognises the directory as a repository
    const project = env.project();
    project.agents["fe-member"]!.sandbox = { write: [path.join(env.root, "ok")], network: [], localBinding: false, unixSockets: [] };
    const events: [string, Record<string, unknown>][] = [];
    let calls = 0;
    const inp = { project, agent: project.agents["fe-member"]!, workDir: env.repo, systemPrompt: "S", userPrompt: "U", timeoutSec: 5 };
    // Sanity: the probe really fails here.
    expect(() => execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: env.repo, stdio: "ignore" })).toThrow();
    const r = await invokeWithSandboxChecks(async () => {
      calls++;
      return okResult;
    }, inp, inp.agent, { event: (n, f) => events.push([n, f]) }, 0);
    expect(r).toMatchObject({ ok: false, kind: "config" });
    expect(r.error).toContain("sandbox refused");
    expect(r.error).toContain("git common dir");
    expect(calls).toBe(0);
    expect(events.map((e) => e[0])).toEqual(["sandbox-refused"]);
  });

  it("a realpath error other than ENOENT/ENOTDIR (a symlink loop, ELOOP) refuses with kind config", async () => {
    env = makeEnv();
    const project = env.project();
    const a = path.join(env.root, "loop-a");
    const b = path.join(env.root, "loop-b");
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    project.agents["fe-member"]!.sandbox = { write: [path.join(a, "x")], network: [], localBinding: false, unixSockets: [] };
    let calls = 0;
    const inp = { project, agent: project.agents["fe-member"]!, workDir: env.repo, systemPrompt: "S", userPrompt: "U", timeoutSec: 5 };
    const r = await invokeWithSandboxChecks(
      async () => {
        calls++;
        return okResult;
      },
      inp,
      inp.agent,
      { event: () => {} },
      0,
    );
    expect(r).toMatchObject({ ok: false, kind: "config" });
    expect(r.error).toContain("ELOOP");
    expect(calls).toBe(0);
  });

  it("a plain directory outside any git checkout is not an error, and a healthy repo passes", async () => {
    env = makeEnv(); // env.repo is not a git repo (a temp dir)
    sandboxOn();
    const project = env.project();
    project.agents["fe-member"]!.sandbox = { write: [path.join(env.root, "ok")], network: [], localBinding: false, unixSockets: [] };
    const inp = { ...input(), project, agent: project.agents["fe-member"]! };
    expect((await invokeWithSandboxChecks(async () => okResult, inp, inp.agent, { event: () => {} }, 0)).ok).toBe(true);
    initGitRepo(env.repo);
    expect((await invokeWithSandboxChecks(async () => okResult, inp, inp.agent, { event: () => {} }, 0)).ok).toBe(true);
  });
});

describe("no-sandbox output is byte-identical to the pre-change code (spec 25.19.2)", () => {
  it("Claude settings and Codex argv equal the output captured at c5980b0", () => {
    // Pinned so the result never depends on the host: the OS probe (darwin / bwrap on PATH) is fixed, and no code on this path reads process.platform.
    setOsSandboxForTest(true);
    env = makeEnv();
    const p = env.project();
    const a = p.agents["fe-member"]!;
    expect(a.sandbox).toBeUndefined();
    const wd = path.join(env.root, "work");
    fs.mkdirSync(wd, { recursive: true });
    const input = { project: p, agent: a, workDir: wd, systemPrompt: "S", userPrompt: "U", timeoutSec: 5 };
    const got = { claude: buildClaudeSettings(p, a), codexFresh: buildCodexInvocation(input).args, codexResume: buildCodexInvocation({ ...input, sessionId: "sid" }).args };
    const norm = (s: string) => s.split(fs.realpathSync(env.root)).join("<ROOT>").split(env.root).join("<ROOT>");
    const expected = fs.readFileSync(path.join(__dirname, "fixtures", "sandbox-base-output.json"), "utf8");
    expect(norm(JSON.stringify(got, null, 1))).toBe(expected);
  });
});

describe("status --json ignores sandbox log events (spec 25.8)", () => {
  it("is identical for a log with sandbox / sandbox-refused events and one without", () => {
    env = makeEnv();
    const p = env.project();
    const id = "20261007T000001000Z-aaaa";
    const dir = path.join(p.paths.runs, id);
    fs.mkdirSync(dir, { recursive: true });
    saveRunState(dir, { ...newRunState({ run_id: id, project: "demo", max_rounds: 5, task_summary: id, pid: 999_999 }), workspace_mode: "worktree", lead_workspace: true });
    const wake = JSON.stringify({ at: "2026-10-07T00:00:00.000Z", event: "wake", agent: "lead", ok: true });
    const base = `${wake}\n`;
    fs.writeFileSync(path.join(dir, "log.jsonl"), base);
    const without = JSON.stringify(buildStatusReport(p));
    const ev = (e: string, f: object) => JSON.stringify({ at: "2026-10-07T00:00:01.000Z", event: e, ...f });
    fs.writeFileSync(path.join(dir, "log.jsonl"), `${ev("sandbox", { agent: "fe-member", attempt: 0, applied: { write: "os" } })}\n${base}${ev("sandbox-refused", { agent: "fe-member", reason: "x" })}\n`);
    expect(JSON.stringify(buildStatusReport(p))).toBe(without);
  });
});

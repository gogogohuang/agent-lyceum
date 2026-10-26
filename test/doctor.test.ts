import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractClaudeResult } from "../src/adapters/claude.js";
import { buildClaudeInvocation } from "../src/adapters/claude.js";
import { buildCodexInvocation } from "../src/adapters/codex.js";
import { diagnoseProject, formatDoctor, preflightRuntimes, probeRuntime, type DoctorReport } from "../src/doctor.js";
import { recordsDir, setOsSandboxForTest } from "../src/policy.js";
import { acquireProjectLock } from "../src/project-lock.js";
import { initGitRepo, makeConcurrent, makeEnv, makeMemoryEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

/** A directory with fake `claude` / `codex` executables whose answers depend on FAKE_CASE; every call is logged. */
function fakeBin(root: string): { bin: string; calls: () => string[] } {
  const bin = path.join(root, "bin");
  const log = path.join(root, "calls.log");
  fs.mkdirSync(bin, { recursive: true });
  const script = (name: string, body: string) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  };
  script(
    "claude",
    `case "$FAKE_CASE" in
  hang) sleep 30 ;;
  garbled) echo "???"; exit 1 ;;
esac
case "$1" in
  --version) if [ "$FAKE_CASE" = old ]; then echo "0.9.0 (Claude Code)"; else echo "2.1.9 (Claude Code)"; fi ;;
  --help)
    echo "Usage: claude [options]"
    echo "  -p, --print"
    echo "  --output-format <format>"
    echo "  --settings <file>"
    [ "$FAKE_CASE" != old ] && echo "  --effort <level>"
    [ "$FAKE_CASE" != noresume ] && [ "$FAKE_CASE" != old ] && echo "  -r, --resume [id]"
    exit 0 ;;
  *) echo "AGENT TASK RAN" ; exit 0 ;;
esac`,
  );
  script(
    "codex",
    `case "$FAKE_CASE" in hang) sleep 30 ;; esac
case "$1 $2" in
  "--version "*) echo "codex-cli 0.40.0" ;;
  "exec --help") echo "  --json"; echo "  -s, --sandbox <mode>"; echo "  -c, --config <k=v>" ;;
  "exec resume") if [ "$FAKE_CASE" = noresume ]; then echo "unrecognized subcommand" >&2; exit 2; fi; echo "resume help"; exit 0 ;;
  *) echo "AGENT TASK RAN" ;;
esac`,
  );
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []) };
}
const envWith = (bin: string, fakeCase: string) => ({ ...process.env, PATH: `${bin}:/usr/bin:/bin`, FAKE_CASE: fakeCase });

describe("probeRuntime", () => {
  it("reads version and capabilities from --version and --help", async () => {
    env = makeEnv();
    const { bin } = fakeBin(env.root);
    const c = await probeRuntime("claude-code", { env: envWith(bin, "full") });
    expect(c).toMatchObject({ runtime: "claude-code", binary: "found", version: "2.1.9 (Claude Code)", json: "yes", resume: "yes", sandbox: "yes", effort: "yes" });
    const x = await probeRuntime("codex", { env: envWith(bin, "full") });
    expect(x).toMatchObject({ runtime: "codex", binary: "found", version: "codex-cli 0.40.0", json: "yes", resume: "yes", sandbox: "yes", effort: "yes" });
  });

  it("tells versions apart: an older CLI lacks resume and effort", async () => {
    env = makeEnv();
    const { bin } = fakeBin(env.root);
    const c = await probeRuntime("claude-code", { env: envWith(bin, "old") });
    expect(c.version).toBe("0.9.0 (Claude Code)");
    expect(c).toMatchObject({ json: "yes", resume: "no", effort: "no" });
  });

  it("says 'no' when help does not list resume, for Codex through its resume subcommand", async () => {
    env = makeEnv();
    const { bin } = fakeBin(env.root);
    expect((await probeRuntime("claude-code", { env: envWith(bin, "noresume") })).resume).toBe("no");
    expect((await probeRuntime("codex", { env: envWith(bin, "noresume") })).resume).toBe("no");
  });

  it("reports a missing binary without failing", async () => {
    env = makeEnv();
    const c = await probeRuntime("claude-code", { env: { ...process.env, PATH: path.join(env.root, "empty") } });
    expect(c.binary).toBe("missing");
    expect(c).toMatchObject({ json: "unknown", resume: "unknown", sandbox: "unknown", effort: "unknown" });
  });

  it("marks everything unknown when the CLI hangs or answers nonsense, within the probe timeout", async () => {
    env = makeEnv();
    const { bin } = fakeBin(env.root);
    const t0 = Date.now();
    const hung = await probeRuntime("claude-code", { env: envWith(bin, "hang"), timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(hung).toMatchObject({ binary: "found", json: "unknown", resume: "unknown", effort: "unknown" });
    expect(hung.notes.join(" ")).toMatch(/timed out/);
    const junk = await probeRuntime("claude-code", { env: envWith(bin, "garbled") });
    expect(junk).toMatchObject({ json: "unknown", resume: "unknown" });
  }, 20_000);
});

describe("diagnoseProject", () => {
  it("never runs an agent: only --version and --help are called", async () => {
    env = makeEnv();
    const { bin, calls } = fakeBin(env.root);
    await diagnoseProject(env.project(), { env: envWith(bin, "full") });
    expect(calls().length).toBeGreaterThan(0);
    for (const c of calls()) expect(c).toMatch(/^(claude|codex) (--version|--help|exec --help|exec resume --help)$/);
  });

  describe("project records", () => {
    const rec = (extra = "") => `---\nstatus: active\ndate: 2026-01-02\ntitle: t\n${extra}---\nbody\n`;
    const recChecks = async () => {
      const { bin } = fakeBin(env.root);
      return (await diagnoseProject(env.project(), { env: envWith(bin, "full") })).checks.filter((c) => c.subject === "records");
    };

    it("is silent for a clean records dir and for a missing one", async () => {
      env = makeEnv();
      expect(await recChecks()).toEqual([]);
      write(path.join(recordsDir(env.project()), "decisions", "d-a.md"), rec());
      write(path.join(recordsDir(env.project()), "decisions", "d-b.md"), rec("supersedes: [d-a]\n"));
      expect(await recChecks()).toEqual([]);
    });

    it("warns about invalid frontmatter and about a supersedes id that does not exist in the same kind", async () => {
      env = makeEnv();
      const rd = recordsDir(env.project());
      write(path.join(rd, "decisions", "d-bad.md"), "no frontmatter\n");
      write(path.join(rd, "decisions", "d-dangling.md"), rec("supersedes: [d-gone, l-one]\n"));
      write(path.join(rd, "lessons", "l-one.md"), rec());
      const checks = await recChecks();
      expect(checks.every((c) => c.level === "warn")).toBe(true);
      const msgs = checks.map((c) => c.message);
      expect(msgs.some((m) => m.includes("d-bad.md") && m.includes("missing frontmatter"))).toBe(true);
      expect(msgs.some((m) => m.includes("d-dangling.md") && m.includes('"d-gone"'))).toBe(true);
      expect(msgs.some((m) => m.includes('"l-one"'))).toBe(true);
      expect(msgs).toHaveLength(3);
    });
  });

  it("lists every active run lock and notes that runs start from HEAD", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    write(path.join(env.repo, "dirty.txt"), "x\n");
    const p = env.project();
    const a = acquireProjectLock(p.paths.root, "run-a", { checkout: false });
    const b = acquireProjectLock(p.paths.root, "run-b", { checkout: false });
    const { bin } = fakeBin(env.root);
    const report = await diagnoseProject(p, { env: envWith(bin, "full") });
    const msgs = report.checks.map((c) => `${c.level}:${c.message}`).join("\n");
    expect(msgs).toMatch(/A run is active: run-a/);
    expect(msgs).toMatch(/A run is active: run-b/);
    expect(msgs).toMatch(/info:.*uncommitted.*start from HEAD/);
    a.release();
    b.release();
  });

  it("reports an unreadable run lock file with the command that clears it", async () => {
    env = makeEnv();
    write(path.join(env.project().paths.root, "locks", "run-bad.json"), "garbage");
    const { bin } = fakeBin(env.root);
    const report = await diagnoseProject(env.project(), { env: envWith(bin, "full") });
    expect(report.checks.map((c) => c.message).join("\n")).toMatch(/run-bad cannot be read.*clear --lock run-bad --force/);
  });

  it("only suggests a memory tidy: it never runs one and never makes the report fail", async () => {
    env = makeMemoryEnv();
    const { bin } = fakeBin(env.root);
    const d = env.project().agents.lead!.memory.project!;
    write(path.join(d, "MEMORY.md"), "- entry\n".repeat(800));
    const r = await diagnoseProject(env.project(), { env: envWith(bin, "full") });
    expect(r.checks.some((c) => c.level === "info" && c.subject === "memory" && /agent-lyceum tidy -p /.test(c.message))).toBe(true);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(d, ".archive"))).toBe(false);
    expect(fs.existsSync(path.join(env.project().paths.root, "tidy-work"))).toBe(false);
  });

  it("is clean for a healthy setup and says login is not checked", async () => {
    env = makeEnv();
    const { bin } = fakeBin(env.root);
    const r = await diagnoseProject(env.project(), { env: envWith(bin, "full") });
    expect(r.ok).toBe(true);
    expect(r.checks.filter((c) => c.level === "error")).toEqual([]);
    expect(JSON.stringify(r)).toMatch(/login.*unknown/i);
  });

  it("errors for a missing binary and for a required feature the CLI explicitly lacks", async () => {
    env = makeEnv();
    const { bin } = fakeBin(env.root);
    const missing = await diagnoseProject(env.project(), { env: { ...process.env, PATH: path.join(env.root, "empty") } });
    expect(missing.ok).toBe(false);
    expect(missing.checks.map((c) => c.message).join("\n")).toMatch(/claude.*not found/i);

    // the demo project's lead has resume: true
    const old = await diagnoseProject(env.project(), { env: envWith(bin, "noresume") });
    expect(old.ok).toBe(false);
    expect(old.checks.find((c) => c.level === "error")?.message).toMatch(/lead.*resume/i);
  });

  describe("fallback chains", () => {
    // claude-code -> codex fallbacks need the OS sandbox (Linux CI has no bubblewrap); pin it so validation passes everywhere
    beforeEach(() => setOsSandboxForTest(true));
    afterEach(() => setOsSandboxForTest(undefined));
    const allClaude = () => {
      const p = env.project();
      for (const a of Object.values(p.agents)) a.runtime = "claude-code";
      return p;
    };

    it("probes a runtime that only a fallback chain uses, once, and reports it as healthy", async () => {
      env = makeEnv();
      const { bin, calls } = fakeBin(env.root);
      const p = allClaude();
      p.agents.lead!.fallback = [{ runtime: "codex", model: "gpt-5" }];
      p.agents["fe-member"]!.fallback = [{ runtime: "codex", model: "gpt-4" }];
      const before = calls().length;
      const r = await diagnoseProject(p, { env: envWith(bin, "full") });
      expect(r.ok).toBe(true);
      expect(calls().slice(before).filter((c) => c.startsWith("codex --version"))).toHaveLength(1);
      expect(r.runtimes.map((c) => c.runtime).sort()).toEqual(["claude-code", "codex"]);
    });

    it("warns (never errors) when the fallback CLI is missing, naming the agents it backs up", async () => {
      env = makeEnv();
      const { bin } = fakeBin(env.root);
      fs.rmSync(path.join(bin, "codex"));
      const p = allClaude();
      p.agents.lead!.fallback = [{ runtime: "codex", model: "gpt-5" }];
      p.agents["fe-member"]!.fallback = [{ runtime: "codex", model: "gpt-4" }];
      const r = await diagnoseProject(p, { env: envWith(bin, "full") });
      expect(r.ok).toBe(true);
      expect(r.checks.filter((c) => c.level === "error")).toEqual([]);
      const w = r.checks.filter((c) => c.level === "warn" && c.subject === "codex");
      expect(w).toHaveLength(1);
      expect(w[0]!.message).toMatch(/codex not found on PATH \(it is a fallback for (lead, fe-member|fe-member, lead)\)/);
    });

    it("does not change anything for a project without a chain", async () => {
      env = makeEnv();
      const { bin } = fakeBin(env.root);
      const a = await diagnoseProject(env.project(), { env: envWith(bin, "full") });
      expect(JSON.stringify(a)).not.toMatch(/fallback/i);
    });
  });

  it("only warns when a capability is unknown, instead of guessing", async () => {
    env = makeEnv();
    const { bin } = fakeBin(env.root);
    const r = await diagnoseProject(env.project(), { env: envWith(bin, "garbled") });
    expect(r.checks.filter((c) => c.level === "error")).toEqual([]);
    expect(r.checks.some((c) => c.level === "warn" && /unknown/i.test(c.message))).toBe(true);
  });

  it("does not print credentials or the environment", async () => {
    env = makeEnv();
    const { bin } = fakeBin(env.root);
    const r = await diagnoseProject(env.project(), { env: { ...envWith(bin, "full"), ANTHROPIC_API_KEY: "sk-secret-123" } });
    expect(JSON.stringify(r)).not.toContain("sk-secret-123");
  });
});

describe("preflightRuntimes", () => {
  it("refuses a run when a needed feature is explicitly missing, and lists unknowns as warnings", async () => {
    env = makeEnv();
    const { bin } = fakeBin(env.root);
    const bad = await preflightRuntimes(env.project(), { env: envWith(bin, "noresume") });
    expect(bad.errors.join("\n")).toMatch(/lead.*resume/i);
    const unknown = await preflightRuntimes(env.project(), { env: envWith(bin, "garbled") });
    expect(unknown.errors).toEqual([]);
    expect(unknown.warnings.join("\n")).toMatch(/unknown/i);
  });
});

describe("preflightRuntimes with a fallback chain", () => {
  it("ignores a missing fallback CLI: it neither blocks the run nor gets probed", async () => {
    env = makeEnv();
    const { bin, calls } = fakeBin(env.root);
    fs.rmSync(path.join(bin, "codex"));
    const p = env.project();
    for (const a of Object.values(p.agents)) a.runtime = "claude-code";
    p.agents.lead!.fallback = [{ runtime: "codex", model: "gpt-5" }];
    const r = await preflightRuntimes(p, { env: envWith(bin, "full") });
    expect(r).toEqual({ errors: [], warnings: [] });
    expect(calls().some((c) => c.startsWith("codex"))).toBe(false);
  });
});

describe("runtime output variants", () => {
  const input = (runtime: "claude-code" | "codex") => {
    env = makeEnv();
    const p = env.project();
    return { project: p, agent: { ...p.agents.lead, runtime }, workDir: path.join(env.root, "w"), systemPrompt: "S", userPrompt: "U", timeoutSec: 5 };
  };
  const feed = (inv: ReturnType<typeof buildClaudeInvocation>, lines: string[], code = 0) => {
    const parser = inv.stream!();
    for (const l of lines) parser.line(l);
    return parser.finish({ code, stdoutTail: lines.join("\n"), stderrTail: "" });
  };

  it("Claude: reads the result from an event array, or a single object, and survives a missing session id", () => {
    const inv = buildClaudeInvocation(input("claude-code"));
    const array = feed(inv, [JSON.stringify([{ type: "system" }, { type: "result", result: "done", usage: { output_tokens: 3 } }])]);
    expect(array).toMatchObject({ ok: true, text: "done", outputTokens: 3 });
    expect(array.sessionId).toBeUndefined();
    expect(feed(inv, ["warming up", '{"result":"one object","session_id":"s9"}', "trailing noise"])).toMatchObject({ ok: true, text: "one object", sessionId: "s9" });
    expect(extractClaudeResult(JSON.stringify([{ type: "result", result: "x" }]))).toMatchObject({ result: "x" });
  });

  it("Claude: an error result or a non-zero exit is a failure with the message", () => {
    const inv = buildClaudeInvocation(input("claude-code"));
    expect(feed(inv, ['{"is_error":true,"result":"rate limited"}'])).toMatchObject({ ok: false, error: "rate limited" });
    expect(feed(inv, ["not json at all"], 1).ok).toBe(false);
  });

  it("Codex: finds the session id and adds up tokens over events, and copes with having none", () => {
    const inv = buildCodexInvocation(input("codex"));
    const lines = ['{"type":"thread.started","thread_id":"t-1"}', "garbage", '{"type":"turn.completed","usage":{"output_tokens":5}}', '{"type":"turn.completed","usage":{"output_tokens":7}}'];
    expect(feed(inv, lines)).toMatchObject({ ok: true, sessionId: "t-1", outputTokens: 12 });
    const none = feed(inv, ["only text"]);
    expect(none.sessionId).toBeUndefined();
    expect(none.outputTokens).toBeUndefined();
  });
});

describe("diagnoseProject pull request hint", () => {
  it("says whether a run could open a pull request when several runs may be active", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    const { bin } = fakeBin(env.root);
    const none = await diagnoseProject(env.project(), { env: envWith(bin, "full") });
    expect(none.checks.map((c) => `${c.level}:${c.subject}:${c.message}`).join("\n")).toMatch(/info:pr:.*cannot open a pull request.*`origin`/);

    execFileSync("git", ["remote", "add", "origin", "https://example.invalid/o/r.git"], { cwd: env.repo });
    fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const ok = await diagnoseProject(env.project(), { env: envWith(bin, "full") });
    expect(ok.checks.map((c) => `${c.level}:${c.subject}`)).toContain("ok:pr");
  });
});

describe("formatDoctor footer", () => {
  const report = (levels: Array<"ok" | "info" | "warn" | "error">): DoctorReport => ({
    project: "p",
    ok: !levels.includes("error"),
    checks: levels.map((level) => ({ level, subject: "s", message: `m-${level}` })),
    runtimes: [],
  });
  const footer = (levels: Array<"ok" | "info" | "warn" | "error">) => formatDoctor(report(levels)).split("\n").at(-1);

  it("says no problems only when nothing is warn or error", () => {
    expect(footer(["ok", "info"])).toBe("No problems found.");
  });
  it("counts warnings without claiming no problems", () => {
    expect(footer(["ok", "warn"])).toBe("No errors; 1 warning to review (marked warn above).");
    expect(footer(["warn", "warn", "info"])).toBe("No errors; 2 warnings to review (marked warn above).");
  });
  it("counts errors and warnings with singular and plural", () => {
    expect(footer(["error"])).toBe("Problems found: 1 error (marked ERROR above).");
    expect(footer(["error", "warn"])).toBe("Problems found: 1 error, 1 warning (marked ERROR / warn above).");
    expect(footer(["error", "error", "warn", "warn"])).toBe("Problems found: 2 errors, 2 warnings (marked ERROR / warn above).");
  });
  it("reflects a check pushed after diagnoseProject (task-file error)", () => {
    const r = report(["ok"]);
    r.checks.push({ level: "error", subject: "task-file", message: "missing" });
    expect(formatDoctor(r).split("\n").at(-1)).toBe("Problems found: 1 error (marked ERROR above).");
  });
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractClaudeResult } from "../src/adapters/claude.js";
import { buildClaudeInvocation } from "../src/adapters/claude.js";
import { buildCodexInvocation } from "../src/adapters/codex.js";
import { diagnoseProject, preflightRuntimes, probeRuntime } from "../src/doctor.js";
import { makeEnv, makeMemoryEnv, write, type TestEnv } from "./helpers.js";

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

  it("only suggests a memory tidy: it never runs one and never makes the report fail", async () => {
    env = makeMemoryEnv();
    const { bin } = fakeBin(env.root);
    const d = env.project().agents.lead!.memory.project!;
    write(path.join(d, "MEMORY.md"), "- entry\n".repeat(800));
    const r = await diagnoseProject(env.project(), { env: envWith(bin, "full") });
    expect(r.checks.some((c) => c.level === "info" && c.subject === "memory" && /memory tidy/.test(c.message))).toBe(true);
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInvocation } from "../src/adapters/index.js";
import { buildCursorInvocation, classifyCursorError, writeCursorCliConfig } from "../src/adapters/cursor.js";
import type { WakeInput } from "../src/adapters/types.js";
import { outboxDir, writePolicy } from "../src/policy.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
let srcDir: string;
const prevConfigDir = process.env.CURSOR_CONFIG_DIR;
// Never read the user's real ~/.cursor: every test gets an empty temp source config dir.
beforeEach(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-src-"));
  process.env.CURSOR_CONFIG_DIR = srcDir;
});
afterEach(() => {
  env?.cleanup();
  fs.rmSync(srcDir, { recursive: true, force: true });
  if (prevConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR;
  else process.env.CURSOR_CONFIG_DIR = prevConfigDir;
});

const wake = (e: TestEnv, name: string, extra: Partial<WakeInput> = {}): WakeInput => {
  const project = e.project();
  const agent = { ...project.agents[name]!, runtime: "cursor" as const, model: "grok-4.7", effort: undefined };
  return {
    project,
    agent,
    workDir: path.join(e.root, "work", name),
    systemPrompt: "SYS",
    userPrompt: "USER",
    timeoutSec: 5,
    ...extra,
  };
};

const ndjson = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("cursor adapter", () => {
  it("builds headless agent invocation with grok model and CURSOR_CONFIG_DIR", () => {
    env = makeEnv();
    const inv = buildCursorInvocation(wake(env, "fe-member"));
    expect(inv.cmd).toBe("agent");
    expect(inv.args).toEqual(expect.arrayContaining(["-p", "--force", "--trust", "--sandbox", "enabled", "--model", "grok-4.7", "--output-format", "stream-json"]));
    expect(inv.env?.CURSOR_CONFIG_DIR).toBe(path.join(env.root, "work", "fe-member"));
    expect(fs.existsSync(path.join(inv.env!.CURSOR_CONFIG_DIR!, "cli-config.json"))).toBe(true);
    expect(inv.stdin).toBe("");
    expect(inv.args[inv.args.length - 1]).toBe("SYS\n\n=====\n\nUSER");
  });

  it("passes --workspace with the repo dir and never writes a repo .cursor/cli.json", () => {
    env = makeEnv();
    const inv = buildCursorInvocation(wake(env, "fe-member"));
    const i = inv.args.indexOf("--workspace");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(inv.args[i + 1]).toBe(inv.cwd);
    expect(fs.existsSync(path.join(env.repo, ".cursor", "cli.json"))).toBe(false);
  });

  it("passes --add-dir for writable paths outside the workspace, deduplicated, never workDir", () => {
    env = makeEnv();
    const w = wake(env, "fe-member");
    const inv = buildCursorInvocation(w);
    const dirs = inv.args.flatMap((a, i) => (a === "--add-dir" ? [inv.args[i + 1]!] : []));
    const pol = writePolicy(w.project, w.agent);
    expect(dirs).toContain(outboxDir(w.project, "fe-member"));
    for (const d of pol.allowDirs.filter((d) => !(d === inv.cwd || d.startsWith(inv.cwd + path.sep)))) expect(dirs).toContain(d);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(dirs).not.toContain(w.workDir);
    // the prompt stays the last, positional argument
    expect(inv.args[inv.args.length - 1]).toBe("SYS\n\n=====\n\nUSER");

    const o = wake(env, "fe-member", { policy: { allowDirs: ["/a/dir", "/a/dir"], readDirs: [], allowFiles: ["/a/file.md", "/b/x.md"], deny: [] } });
    const od = buildCursorInvocation(o).args;
    const odirs = od.flatMap((a, i) => (a === "--add-dir" ? [od[i + 1]!] : []));
    expect(odirs).toEqual(["/a/dir", "/a", "/b"]);
  });

  it("rejects a prompt too long for argv before creating anything", () => {
    env = makeEnv();
    const w = wake(env, "fe-member", { userPrompt: "x".repeat(100_001) });
    expect(() => buildCursorInvocation(w)).toThrow(/prompt too long for argv/i);
    expect(fs.existsSync(w.workDir)).toBe(false);
    // multibyte counts by bytes, not characters
    expect(() => buildCursorInvocation(wake(env, "fe-member", { userPrompt: "好".repeat(40_000) }))).toThrow(/too long/);
  });

  it("realInvoker turns an oversized prompt into a config failure instead of throwing", async () => {
    env = makeEnv();
    const { realInvoker } = await import("../src/adapters/index.js");
    const r = await realInvoker(wake(env, "fe-member", { userPrompt: "x".repeat(100_001) }));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("config");
    expect(r.error).toMatch(/too long/);
  });

  it("keeps a flag-looking prompt from being parsed as an option", () => {
    env = makeEnv();
    const inv = buildCursorInvocation(wake(env, "fe-member", { systemPrompt: "--force it" }));
    expect(inv.args[inv.args.length - 1]!.startsWith("-")).toBe(false);
    expect(inv.args[inv.args.length - 1]).toContain("--force it");
  });

  it("passes --resume when sessionId set", () => {
    env = makeEnv();
    const inv = buildCursorInvocation(wake(env, "fe-member", { sessionId: "chat-1" }));
    const i = inv.args.indexOf("--resume");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(inv.args[i + 1]).toBe("chat-1");
  });

  it("is wired into buildInvocation", () => {
    env = makeEnv();
    expect(buildInvocation(wake(env, "fe-member")).cmd).toBe("agent");
  });

  it("writes cli-config.json with deny rules from the write policy and web denied by default", () => {
    env = makeEnv();
    const w = wake(env, "fe-member", { policy: { allowDirs: [], readDirs: [], allowFiles: [], deny: ["/x/protected"] } });
    const file = writeCursorCliConfig(w.workDir, w);
    expect(file).toBe(path.join(w.workDir, "cli-config.json"));
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(cfg.version).toBe(1);
    expect(cfg.permissions.deny).toEqual(expect.arrayContaining(["Write(/x/protected)", "WebFetch(*)"]));
  });

  it("allows WebFetch when allowWeb is fetch", () => {
    env = makeEnv();
    const w = wake(env, "fe-member");
    w.agent = { ...w.agent, allowWeb: "fetch" };
    const cfg = JSON.parse(fs.readFileSync(writeCursorCliConfig(w.workDir, w), "utf8"));
    expect(cfg.permissions.allow).toContain("WebFetch(*)");
    expect(cfg.permissions.deny).not.toContain("WebFetch(*)");
  });

  it("allows Write on memory/outbox dirs and policy files so they work outside --workspace", () => {
    env = makeEnv();
    const w = wake(env, "fe-member");
    const cfg = JSON.parse(fs.readFileSync(writeCursorCliConfig(w.workDir, w), "utf8"));
    const pol = writePolicy(w.project, w.agent);
    expect(pol.allowDirs.length).toBeGreaterThan(0);
    expect(cfg.permissions.allow).toContain(`Write(${pol.allowDirs[0]}/**)`);
    expect(cfg.permissions.allow).toContain(`Write(${outboxDir(w.project, "fe-member")}/**)`);
    const o = wake(env, "fe-member", { policy: { allowDirs: ["/a/dir"], readDirs: [], allowFiles: ["/a/file.md"], deny: ["/a/dir/secret"] } });
    const oc = JSON.parse(fs.readFileSync(writeCursorCliConfig(o.workDir, o), "utf8"));
    expect(oc.permissions.allow).toEqual(expect.arrayContaining(["Write(/a/dir/**)", "Write(/a/file.md)"]));
    expect(oc.permissions.deny).toContain("Write(/a/dir/secret)");
  });

  it("carries auth.json and keeps version/editor/deny from source, but never merges source allow", () => {
    env = makeEnv();
    fs.writeFileSync(path.join(srcDir, "auth.json"), '{"token":"t"}');
    fs.writeFileSync(
      path.join(srcDir, "cli-config.json"),
      JSON.stringify({ version: 7, editor: { vimMode: true }, permissions: { allow: ["Shell(ls)", "Shell(*)"], deny: ["Read(.env)"] } }),
    );
    const w = wake(env, "fe-member");
    const file = writeCursorCliConfig(w.workDir, w);
    expect(fs.readFileSync(path.join(w.workDir, "auth.json"), "utf8")).toBe('{"token":"t"}');
    // preferred: a link, so no second copy of the credential is left in the run's dir
    // a copy (0600), not a link: a token refresh in the run dir must never reach the user's own login file
    expect(fs.lstatSync(path.join(w.workDir, "auth.json")).isSymbolicLink()).toBe(false);
    fs.writeFileSync(path.join(w.workDir, "auth.json"), "refreshed");
    expect(fs.readFileSync(path.join(srcDir, "auth.json"), "utf8")).toBe('{"token":"t"}');
    fs.writeFileSync(path.join(w.workDir, "auth.json"), '{"token":"t"}');
    // a later wake replaces a stale copy
    fs.rmSync(path.join(w.workDir, "auth.json"));
    fs.writeFileSync(path.join(w.workDir, "auth.json"), "stale");
    writeCursorCliConfig(w.workDir, w);
    expect(fs.readFileSync(path.join(w.workDir, "auth.json"), "utf8")).toBe('{"token":"t"}');
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(cfg.version).toBe(7);
    expect(cfg.editor).toEqual({ vimMode: true });
    expect(cfg.permissions.allow).toContain(`Write(${outboxDir(w.project, "fe-member")}/**)`);
    expect(cfg.permissions.allow).not.toContain("Shell(ls)");
    expect(cfg.permissions.allow).not.toContain("Shell(*)");
    expect(cfg.permissions.deny).toEqual(expect.arrayContaining(["Read(.env)", "WebFetch(*)"]));
    // source untouched
    expect(JSON.parse(fs.readFileSync(path.join(srcDir, "cli-config.json"), "utf8")).version).toBe(7);
  });

  it("works without auth.json or a source cli-config.json", () => {
    env = makeEnv();
    const w = wake(env, "fe-member");
    const cfg = JSON.parse(fs.readFileSync(writeCursorCliConfig(w.workDir, w), "utf8"));
    expect(cfg.version).toBe(1);
    expect(fs.existsSync(path.join(w.workDir, "auth.json"))).toBe(false);
  });

  it("classifies auth and rate limit with anchored phrases (not bare 401/429)", () => {
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "Unauthorized: not logged in" })).toBe("auth");
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "401 Unauthorized" })).toBe("auth");
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "429 Too Many Requests" })).toBe("rate_limit");
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "usage limit reached" })).toBe("quota");
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "connect ECONNREFUSED" })).toBe("network");
    expect(classifyCursorError({ code: null, stdout: "", stderr: "" })).toBe("crash");
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "weird" })).toBe("unknown");
    // bare numbers / line noise must not become rate_limit or auth
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "see port 4290" })).toBe("unknown");
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "error code 4010" })).toBe("unknown");
  });

  it("parses stream-json: last result text and session_id", () => {
    env = makeEnv();
    const inv = buildCursorInvocation(wake(env, "fe-member"));
    const stdout = ndjson(
      { type: "system", subtype: "init", session_id: "s-1" },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] }, session_id: "s-1" },
      { type: "result", subtype: "success", is_error: false, result: "pong", session_id: "s-1" },
    );
    expect(inv.parse({ stdout, stderr: "", code: 0 })).toMatchObject({ ok: true, text: "pong", sessionId: "s-1" });
    const sp = inv.stream!();
    for (const l of stdout.split("\n").filter(Boolean)) sp.line(l);
    expect(sp.finish({ code: 0, stdoutTail: "", stderrTail: "" })).toMatchObject({ ok: true, text: "pong", sessionId: "s-1" });
  });

  it("reports failure with classified kind", () => {
    env = makeEnv();
    const inv = buildCursorInvocation(wake(env, "fe-member"));
    const r = inv.parse({ stdout: "", stderr: "Unauthorized: not logged in", code: 1 });
    expect(r).toMatchObject({ ok: false, kind: "auth" });
    const e = inv.parse({ stdout: ndjson({ type: "result", is_error: true, result: "429 Too Many Requests", session_id: "s" }), stderr: "", code: 1 });
    expect(e).toMatchObject({ ok: false, kind: "rate_limit", sessionId: "s" });
  });
});

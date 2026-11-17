import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInvocation } from "../src/adapters/index.js";
import { buildCursorInvocation, classifyCursorError, writeCursorCliConfig } from "../src/adapters/cursor.js";
import type { WakeInput } from "../src/adapters/types.js";
import { ApprovalError } from "../src/approval-error.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

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

  it("passes --resume when sessionId set", () => {
    env = makeEnv();
    const inv = buildCursorInvocation(wake(env, "fe-member", { sessionId: "chat-1" }));
    const i = inv.args.indexOf("--resume");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(inv.args[i + 1]).toBe("chat-1");
  });

  it("refuses enrolled agents", () => {
    env = makeEnv();
    const w = wake(env, "fe-member");
    w.agent = { ...w.agent, enrolled: true };
    expect(() => buildCursorInvocation(w)).toThrow(ApprovalError);
    expect(() => buildCursorInvocation(w)).toThrow(/Approval-enrolled agent cannot use Cursor: fe-member/);
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

  it("classifies auth and rate limit", () => {
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "Unauthorized: not logged in" })).toBe("auth");
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "429 Too Many Requests" })).toBe("rate_limit");
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "usage limit reached" })).toBe("quota");
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "connect ECONNREFUSED" })).toBe("network");
    expect(classifyCursorError({ code: null, stdout: "", stderr: "" })).toBe("crash");
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "weird" })).toBe("unknown");
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

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeInvocation } from "../src/adapters/claude.js";
import { buildCodexInvocation } from "../src/adapters/codex.js";
import { parseShipEditsPayload, runShipCli } from "../src/ship-cli.js";
import { applyShipToWake, shipDefaultVerify, writeShipSession } from "../src/ship-wire.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("ship wiring (CLI for Claude Code and Codex)", () => {
  it("resolves default verify from agent.ship.verify then project.verify", () => {
    env = makeEnv();
    env.editProjectYaml((t) =>
      t
        .replace(
          "  fe-member:\n    can_message",
          "  fe-member:\n    ship:\n      verify: npm test -w pkg\n    can_message",
        )
        .replace(/\n$/, "\nverify:\n  commands:\n    - { name: unit, run: npm test }\n"),
    );
    const p = env.project();
    expect(shipDefaultVerify(p, p.agents["fe-member"]!)).toBe("npm test -w pkg");
    env.editProjectYaml((t) => t.replace(/ship:\n {6}verify: npm test -w pkg\n/, "ship: true\n"));
    const p2 = env.project();
    expect(shipDefaultVerify(p2, p2.agents["fe-member"]!)).toBe("npm test");
  });

  it("writes a ship session and appends the CLI to both Claude and Codex prompts", () => {
    env = makeEnv();
    env.editProjectYaml((t) =>
      t.replace("  fe-member:\n    can_message", '  fe-member:\n    ship:\n      verify: "true"\n    can_message'),
    );
    const p = env.project();
    const workDir = path.join(env.root, "wake-fe");
    const agentClaude = { ...p.agents["fe-member"]!, runtime: "claude-code" as const };
    const agentCodex = { ...p.agents["fe-member"]!, runtime: "codex" as const };
    const project = { ...p, agents: { ...p.agents, "fe-member": agentClaude } };

    const session = writeShipSession(project, agentClaude, workDir);
    expect(session?.sessionPath).toBe(path.join(workDir, "ship-session.json"));
    const body = JSON.parse(fs.readFileSync(session!.sessionPath, "utf8")) as { verify: string; deny: string[] };
    expect(body.verify).toBe("true");
    expect(body.deny).toEqual(expect.any(Array));

    const base = {
      project,
      workDir,
      systemPrompt: "S",
      userPrompt: "U",
      timeoutSec: 60,
    };
    const claude = buildClaudeInvocation({ ...base, agent: agentClaude });
    expect(claude.args).not.toContain("--mcp-config");
    expect(fs.readFileSync(path.join(workDir, "system-prompt.md"), "utf8")).toContain("ship --session");
    expect(fs.readFileSync(path.join(workDir, "system-prompt.md"), "utf8")).toContain(session!.sessionPath);
    expect(claude.args).toEqual(expect.arrayContaining(["--add-dir", workDir]));

    const codexWork = path.join(env.root, "wake-codex");
    const codex = buildCodexInvocation({
      ...base,
      workDir: codexWork,
      project: { ...project, agents: { ...project.agents, "fe-member": agentCodex } },
      agent: agentCodex,
    });
    expect(codex.stdin).toContain("ship --session");
    expect(codex.stdin).toContain(path.join(codexWork, "ship-session.json"));
  });

  it("does not attach ship when verify is missing", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("  fe-member:\n    can_message", "  fe-member:\n    ship: true\n    can_message"));
    const p = env.project();
    const agent = { ...p.agents["fe-member"]!, runtime: "claude-code" as const };
    expect(writeShipSession(p, agent, path.join(env.root, "w"))).toBeUndefined();
    const { ship, input } = applyShipToWake({
      project: p,
      agent,
      workDir: path.join(env.root, "w2"),
      systemPrompt: "S",
      userPrompt: "U",
      timeoutSec: 60,
    });
    expect(ship).toBeUndefined();
    expect(input.systemPrompt).toBe("S");
  });
});

describe("ship CLI", () => {
  it("rejects any verify key in the edits payload", () => {
    const edits = [{ path: "a", search: "x", replace: "y" }];
    expect(() => parseShipEditsPayload({ edits, verify: "evil" })).toThrow(/verify/);
    expect(() => parseShipEditsPayload({ edits, verify: 123 })).toThrow(/verify/);
    expect(() => parseShipEditsPayload({ edits, verify: null })).toThrow(/verify/);
  });

  it("runs ship from a session file", async () => {
    env = makeEnv();
    const root = env.repo;
    fs.writeFileSync(path.join(root, "x.js"), "const n = 1;\n");
    const sessionPath = path.join(env.root, "ship-session.json");
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({ root, verify: "true", deny: [], timeoutSec: 30 }),
    );
    const editsPath = path.join(env.root, "edits.json");
    fs.writeFileSync(
      editsPath,
      JSON.stringify({ edits: [{ path: "x.js", search: "const n = 1;", replace: "const n = 2;" }] }),
    );
    const code = await runShipCli({ session: sessionPath, editsFile: editsPath });
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(root, "x.js"), "utf8")).toBe("const n = 2;\n");
  });
});

describe("ship CLI interruption", () => {
  function setup(verify: string) {
    env = makeEnv();
    fs.writeFileSync(path.join(env.repo, "x.js"), "const n = 1;\n");
    const sessionPath = path.join(env.root, "ship-session.json");
    fs.writeFileSync(sessionPath, JSON.stringify({ root: env.repo, verify, deny: [], timeoutSec: 30 }));
    const editsPath = path.join(env.root, "edits.json");
    fs.writeFileSync(editsPath, JSON.stringify({ edits: [{ path: "x.js", search: "const n = 1;", replace: "const n = 2;" }] }));
    return { sessionPath, editsPath };
  }

  it("exits non-zero and restores files on SIGHUP during verify, then removes its handlers", async () => {
    const { sessionPath, editsPath } = setup("sleep 30");
    const before = process.listenerCount("SIGHUP");
    const p = runShipCli({ session: sessionPath, editsFile: editsPath });
    const deadline = Date.now() + 5000;
    while (process.listenerCount("SIGHUP") === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(process.listenerCount("SIGHUP")).toBe(before + 1);
    await new Promise((r) => setTimeout(r, 200));
    process.emit("SIGHUP");
    const code = await p;
    expect(code).toBe(1);
    expect(fs.readFileSync(path.join(env.repo, "x.js"), "utf8")).toBe("const n = 1;\n");
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });

  it("removes signal handlers after a normal run", async () => {
    const { sessionPath, editsPath } = setup("true");
    const counts = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((s) => process.listenerCount(s));
    expect(await runShipCli({ session: sessionPath, editsFile: editsPath })).toBe(0);
    expect((["SIGINT", "SIGTERM", "SIGHUP"] as const).map((s) => process.listenerCount(s))).toEqual(counts);
  });
});

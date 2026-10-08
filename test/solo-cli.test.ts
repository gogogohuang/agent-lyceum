import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunState } from "../src/run-store.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

let env: TestEnv;
afterEach(() => env?.cleanup());

/** The real CLI with a scripted stand-in for `claude`. */
function setup(script: object, o: { noCodex?: boolean } = {}) {
  env = makeEnv();
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const scriptFile = path.join(env.root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  // noCodex: a PATH with only node, the fake claude and the system tools, so a `codex` binary is certainly missing.
  if (o.noCodex) fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const vars = { ...process.env, PATH: o.noCodex ? `${bin}:/usr/bin:/bin` : `${bin}:${process.env.PATH}`, FAKE_SCRIPT: scriptFile };
  const sync = (args: string[], cwd?: string) => {
    const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8", env: vars, cwd, stdio: ["ignore", "pipe", "pipe"] });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { sync };
}

/** Add `name` to the global library only (not to the demo project). */
function addGlobalAgent(name: string) {
  write(path.join(env.home, "agents", name, "AGENT.md"), `# ${name}\n\nYou clarify requirements.\n`);
  fs.appendFileSync(path.join(env.home, "team.yaml"), `  ${name}:\n    runtime: claude-code\n    agent_md: agents/${name}/AGENT.md\n    memory: { global: agents/${name}/memory }\n`);
}

describe("run --agent", { timeout: 60_000 }, () => {
  it("runs one member alone to its done and exits 0", () => {
    const t = setup({ calls: [{ agent: "fe-member", mail: [{ type: "done", subject: "r", outcome: "completed" }] }] });
    const r = t.sync(["run", "tidy the form", "--agent", "fe-member", "-p", "demo"]);
    expect(r.code).toBe(0);
    const runs = env.project().paths.runs;
    const [id] = fs.readdirSync(runs);
    expect(loadRunState(path.join(runs, id!)).solo_agent).toBe("fe-member");
  });

  it("names the members when the agent is not one of them, and points a global-only agent to `call`", () => {
    const t = setup({ calls: [] });
    addGlobalAgent("pm");
    const none = t.sync(["run", "x", "--agent", "nobody", "-p", "demo"]);
    expect(none.code).toBe(1);
    expect(none.err).toMatch(/lead, fe-member, qa-member/);
    const pm = t.sync(["run", "x", "--agent", "pm", "-p", "demo"]);
    expect(pm.code).toBe(1);
    expect(pm.err).toMatch(/agent-lyceum call pm/);
    expect(fs.existsSync(env.project().paths.runs) ? fs.readdirSync(env.project().paths.runs) : []).toEqual([]);
  });

  it("warns that --assume-defaults has no effect", () => {
    const t = setup({ calls: [{ agent: "fe-member", mail: [{ type: "done", subject: "r", outcome: "completed" }] }] });
    const r = t.sync(["run", "x", "--agent", "fe-member", "--assume-defaults", "-p", "demo"]);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/--assume-defaults.*ignored/);
  });
});

describe("resume of a solo run", { timeout: 60_000 }, () => {
  it("checks only the solo agent's runtime, not a teammate's that is not installed", () => {
    const t = setup({ calls: [] }, { noCodex: true }); // the fake claude fails: the solo run ends without done and can be resumed
    env.editProjectYaml((y) => y.replace("  qa-member:\n    can_message", "  qa-member:\n    runtime: codex\n    can_message"));
    const first = t.sync(["run", "x", "--agent", "fe-member", "-p", "demo"]);
    expect(first.err).not.toMatch(/codex not found/);
    const runs = env.project().paths.runs;
    const [id] = fs.readdirSync(runs);
    expect(loadRunState(path.join(runs, id!)).end_reason).not.toBe("done");
    const r = t.sync(["resume", "-p", "demo"]);
    expect(r.err).not.toMatch(/codex not found/);
    expect(r.err).not.toMatch(/^ERROR/m);
    expect(fs.readdirSync(runs)).toEqual([id]); // the same run, continued
    // A team run still needs every runtime.
    expect(t.sync(["run", "x", "-p", "demo"]).err).toMatch(/codex not found/);
  });
});

describe("call", { timeout: 60_000 }, () => {
  it("prints only the answer on stdout, keeps a record, and takes no project lock", () => {
    const t = setup({ calls: [{ agent: "pm", result: "ask the owner first" }] });
    addGlobalAgent("pm");
    const r = t.sync(["call", "pm", "is this ready to build?", "--dir", env.repo]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("ask the owner first");
    expect(r.err).toMatch(/Calling pm/);
    const calls = path.join(env.home, "calls");
    const [id] = fs.readdirSync(calls).filter((n) => !n.startsWith("."));
    expect(fs.readFileSync(path.join(calls, id!, "result.md"), "utf8")).toMatch(/ask the owner first/);
    expect(fs.readFileSync(path.join(calls, id!, "task.md"), "utf8")).toBe("is this ready to build?");
    expect(fs.existsSync(path.join(env.project().paths.root, "lock.json"))).toBe(false);
    expect(fs.existsSync(path.join(calls, ".lock-pm"))).toBe(false);
  });

  it("works without any registered project, in the current directory, with --task-file", () => {
    const t = setup({ calls: [{ agent: "pm", result: "fine" }] });
    addGlobalAgent("pm");
    const elsewhere = path.join(env.root, "elsewhere");
    fs.mkdirSync(elsewhere);
    write(path.join(elsewhere, "ask.md"), "review the plan\n");
    const r = t.sync(["call", "pm", "--task-file", "ask.md"], elsewhere);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("fine");
  });

  it("exits 1 for a failed call, an unknown agent, no task and both task forms", () => {
    const t = setup({ calls: [] }); // the fake claude fails: no scripted call
    addGlobalAgent("pm");
    expect(t.sync(["call", "pm", "x", "--dir", env.repo]).code).toBe(1);
    const unknown = t.sync(["call", "nobody", "x"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/Global agents: .*pm/);
    expect(t.sync(["call", "pm"]).code).toBe(1);
    expect(t.sync(["call", "pm", "x", "--task-file", "y.md"]).err).toMatch(/either/);
  });
});

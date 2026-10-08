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
function setup(script: object) {
  env = makeEnv();
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const scriptFile = path.join(env.root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  const vars = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SCRIPT: scriptFile };
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

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeInput } from "../src/adapters/index.js";
import { assertApprovalConfig, enrollProject } from "../src/approval-runtime.js";
import { callAgent, resolveCallAgent } from "../src/call.js";
import { ConfigError, type ResolvedProject } from "../src/config.js";
import { agentForCandidate, candidatesFor } from "../src/fallback.js";
import { instanceCap } from "../src/instances.js";
import { bindRunProject } from "../src/run-store.js";
import { soloProject } from "../src/solo.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const SECRET = "hunter2-sentinel-secret";
let env: TestEnv;
afterEach(() => env?.cleanup());

const exec = (allow: string): string =>
  `executors:\n  x:\n    command: ["/opt/x/bin/tool"]\n    allow: ${allow}\n    timeout_sec: 5\n    env:\n      TOKEN: ${SECRET}\n  y:\n    command: ["/opt/y/tool"]\n    allow: []\n    timeout_sec: 5\n`;
const execFile = (): string => path.join(env.home, "executors.yaml");
const writeExec = (text: string): void => fs.writeFileSync(execFile(), text);
const never: Invoker = async () => { throw new Error("an agent was invoked"); };

describe("default-off: no metadata attached", () => {
  it("absent file and all-empty allow lists leave the resolved project identical", () => {
    env = makeEnv();
    const base = JSON.stringify(env.project());
    expect(base).not.toMatch(/enrolled|approval/);
    writeExec(exec("[]"));
    expect(JSON.stringify(env.project())).toBe(base);
  });
});

describe("runtime enrollment", () => {
  it("enrolls only the listed (project, agent) tuple and projects no executor env", () => {
    env = makeEnv();
    writeExec(exec("[{project: demo, agent: fe-member}]"));
    const p = env.project();
    expect(p.approvalError).toBeUndefined();
    expect(p.agents["fe-member"]!.enrolled).toBe(true);
    expect(p.agents["fe-member"]!.approval).toEqual({ identity: { project: "demo" }, commands: ["/opt/x/bin/tool", "/opt/y/tool"], maxScanEntries: 200 });
    for (const n of ["lead", "qa-member"]) expect(p.agents[n]).not.toHaveProperty("enrolled");
    expect(JSON.stringify(p)).not.toContain(SECRET);
  });

  it("a same-named agent in another project, or a call entry, does not enroll a project agent", () => {
    env = makeEnv();
    writeExec(exec("[{project: other, agent: fe-member}, {call: fe-member}]"));
    expect(Object.values(env.project().agents).some((a) => a.enrolled)).toBe(false);
  });

  it("call identity has project null: only `call` entries match, and no secret is carried", () => {
    env = makeEnv();
    writeExec(exec("[{project: demo, agent: fe-member}]"));
    expect(resolveCallAgent(env.home, "fe-member").enrolled).toBeUndefined();
    writeExec(exec("[{call: fe-member}]"));
    const a = resolveCallAgent(env.home, "fe-member");
    expect(a.enrolled).toBe(true);
    expect(a.approval!.identity).toEqual({ project: null });
    expect(JSON.stringify(a)).not.toContain(SECRET);
    expect(resolveCallAgent(env.home, "qa-member").enrolled).toBeUndefined();
  });

  it("follows the agent through fallback candidates (even codex) and tiers", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("dispatcher:\n", "dispatcher:\n  fallback: [{runtime: codex, model: fixture-model}]\n"));
    writeExec(exec("[{project: demo, agent: fe-member}]"));
    const a = env.project().agents["fe-member"]!;
    const backup = candidatesFor(a).find((c) => !c.primary)!;
    const moved = agentForCandidate(a, backup);
    expect(moved.runtime).toBe("codex");
    expect(moved.enrolled).toBe(true);
    expect(moved.approval).toEqual(a.approval);
    const tiered = candidatesFor(a, "tier-model").find((c) => c.tiered)!;
    expect(agentForCandidate(a, tiered)).toMatchObject({ model: "tier-model", enrolled: true, approval: a.approval });
  });

  it("follows the agent into solo, a bound run, instances and resume; enrolled roles cap at one instance", () => {
    env = makeEnv();
    writeExec(exec("[{project: demo, agent: fe-member}]"));
    const p = env.project();
    expect(soloProject(p, "fe-member").agents["fe-member"]!.enrolled).toBe(true);
    const bound = bindRunProject(p, path.join(p.paths.runs, "r1"), "run", { roles: { "fe-member": ["fe-member--2"] } });
    expect(bound.agents["fe-member"]!.enrolled).toBe(true);
    expect(bound.agents["fe-member--2"]!.enrolled).toBe(true);
    expect(bound.agents["fe-member--2"]!.approval).toEqual(p.agents["fe-member"]!.approval);
    expect(instanceCap(bound, "worktree", "fe-member").n).toBe(1);
    expect(instanceCap(bound, "worktree", "qa-member").n).toBeGreaterThan(1);
  });

  it("re-resolving after the file changed picks the new membership (no cache)", () => {
    env = makeEnv();
    writeExec(exec("[{project: demo, agent: fe-member}]"));
    expect(env.project().agents["fe-member"]!.enrolled).toBe(true);
    writeExec(exec("[{project: demo, agent: qa-member}]"));
    const p = env.project();
    expect(p.agents["fe-member"]!.enrolled).toBeUndefined();
    expect(p.agents["qa-member"]!.enrolled).toBe(true);
  });
});

describe("D1: an unreadable executors.yaml stops the agent-starting commands", () => {
  const bad: Record<string, (file: string, root: string) => void> = {
    "malformed YAML": (f) => fs.writeFileSync(f, `executors: [\n  ${SECRET}`),
    alias: (f) => fs.writeFileSync(f, `a: &x ${SECRET}\nexecutors: {}\nb: *x\n`),
    "duplicate key": (f) => fs.writeFileSync(f, `executors: {}\nexecutors: {}\n# ${SECRET}\n`),
    oversize: (f) => fs.writeFileSync(f, `# ${SECRET}\n${"#".repeat(1024 * 1024 + 8)}\n`),
    FIFO: (f) => void execFileSync("mkfifo", [f]),
    symlink: (f, root) => { fs.writeFileSync(path.join(root, "real.yaml"), exec("[]")); fs.symlinkSync(path.join(root, "real.yaml"), f); },
    "unknown key": (f) => fs.writeFileSync(f, `executors: {}\nunexpected: ${SECRET}\n`),
  };
  for (const [label, make] of Object.entries(bad)) {
    it(`${label}: resolveProject records the error and call/assert refuse with the path and no values`, async () => {
      env = makeEnv();
      make(execFile(), env.root);
      let p!: ResolvedProject;
      expect(() => { p = env.project(); }).not.toThrow();
      expect(p.approvalError!.file).toBe(execFile());
      expect(Object.values(p.agents).some((a) => a.enrolled)).toBe(false);
      for (const fn of [() => assertApprovalConfig(p), () => resolveCallAgent(env.home, "fe-member")]) {
        let msg = "";
        try { fn(); } catch (e) { expect(e).toBeInstanceOf(ConfigError); msg = (e as Error).message; }
        expect(msg).toContain(execFile());
        expect(msg).not.toContain(SECRET);
      }
      let calls = 0;
      const inv: Invoker = async (i: WakeInput) => { calls++; return never(i); };
      await expect(callAgent({ home: env.home, agent: "fe-member", task: "t", dir: env.repo, invoker: inv, say: () => {} })).rejects.toThrow(execFile());
      expect(calls).toBe(0);
    });
  }

  it("EACCES through an injected io is recorded, not thrown", () => {
    env = makeEnv();
    writeExec(exec("[]"));
    const io = { ...fs, openSync: (() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }) as typeof fs.openSync };
    const p = enrollProject(env.project(), { project: "demo" }, { io });
    expect(p.approvalError).toMatchObject({ file: execFile(), code: "IO_ERROR" });
    expect(p.approvalError!.reason).toBe("cannot read file");
    expect(() => assertApprovalConfig(p)).toThrow(execFile());
  });

  it("a valid file after a broken one works again (nothing is remembered)", () => {
    env = makeEnv();
    writeExec("executors: [\n");
    expect(env.project().approvalError).toBeDefined();
    writeExec(exec("[{project: demo, agent: fe-member}]"));
    expect(env.project().approvalError).toBeUndefined();
  });

  it("run, resume, run --agent and call refuse before any agent starts; status, status --json, doctor, project list keep working", { timeout: 120_000 }, () => {
    env = makeEnv();
    const bin = path.join(env.root, "bin");
    const marker = path.join(env.root, "invoked");
    fs.mkdirSync(bin);
    for (const rt of ["claude", "codex"]) fs.writeFileSync(path.join(bin, rt), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    writeExec(`executors: [\n  ${SECRET}`);
    const vars = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const sh = (args: string[]) => {
      const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8", env: vars, cwd: env.repo, stdio: ["ignore", "pipe", "pipe"] });
      return { code: r.status, text: `${r.stdout}${r.stderr}` };
    };
    for (const args of [["run", "do it", "-p", "demo"], ["run", "do it", "--agent", "fe-member", "-p", "demo"], ["resume", "-p", "demo"], ["call", "fe-member", "hi"]]) {
      const r = sh(args);
      expect(r.code, args.join(" ")).not.toBe(0);
      expect(r.text, args.join(" ")).toContain(execFile());
      expect(r.text).not.toContain(SECRET);
    }
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(env.home, "projects", "demo", "runs")) ? fs.readdirSync(path.join(env.home, "projects", "demo", "runs")) : []).toEqual([]);
    for (const args of [["status", "-p", "demo"], ["status", "--json", "-p", "demo"], ["doctor", "--resolved", "-p", "demo"], ["project"]]) {
      const r = sh(args);
      expect(r.code, `${args.join(" ")}: ${r.text}`).toBe(0);
    }
    const st = sh(["status", "--json", "-p", "demo"]);
    expect(st.text).not.toMatch(/approval|executors/);
  });
});

describe("D1 for tidy", () => {
  it("tidy refuses before any agent starts (path in message, no secret); --dry-run, which wakes nobody, still works", { timeout: 120_000 }, () => {
    env = makeEnv();
    const bin = path.join(env.root, "bin");
    const marker = path.join(env.root, "invoked");
    fs.mkdirSync(bin);
    for (const rt of ["claude", "codex"]) fs.writeFileSync(path.join(bin, rt), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    writeExec(`executors: [\n  ${SECRET}`);
    const sh = (args: string[]) => {
      const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, cwd: env.repo, stdio: ["ignore", "pipe", "pipe"] });
      return { code: r.status, text: `${r.stdout}${r.stderr}` };
    };
    const r = sh(["tidy", "-p", "demo", "--agent", "fe-member", "--layer", "global"]);
    expect(r.code).not.toBe(0);
    expect(r.text).toContain(execFile());
    expect(r.text).not.toContain(SECRET);
    expect(fs.existsSync(marker)).toBe(false);
    expect(sh(["tidy", "-p", "demo", "--dry-run"]).code).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("A1: reasons are fixed categories, never parser text", () => {
  const S = "SENTINEL_SECRET";
  const probes: Record<string, string> = {
    "unknown top-level key": `executors: {}\n${S}: value\n`,
    "unknown executor key": `executors:\n  x:\n    command: ["/opt/x"]\n    allow: []\n    timeout_sec: 5\n    ${S}: 1\n`,
    "YAML tag": `executors:\n  x:\n    command: ["/opt/x"]\n    allow: []\n    timeout_sec: 5\n    env:\n      TOKEN: !${S} ${S}\n`,
    "invalid value": `executors:\n  x:\n    command: ["/opt/x"]\n    allow: []\n    timeout_sec: ${S}\n`,
    "issue path with a secret-looking executor name": `executors:\n  ${S}:\n    command: relative\n    allow: []\n    timeout_sec: 5\n`,
    "allow entry value": `executors:\n  x:\n    command: ["/opt/x"]\n    allow: [{project: "${S} bad name", agent: a}]\n    timeout_sec: 5\n`,
  };
  for (const [label, text] of Object.entries(probes)) {
    it(`${label}: neither approvalError nor the ConfigError carries the sentinel`, () => {
      env = makeEnv();
      writeExec(text);
      const p = env.project();
      expect(p.approvalError, label).toBeDefined();
      expect(JSON.stringify(p.approvalError)).not.toContain(S);
      expect(p.approvalError!.reason).toMatch(/^invalid content/);
      let msg = "";
      try { assertApprovalConfig(p); } catch (e) { msg = (e as Error).message; }
      expect(msg).toContain(execFile());
      expect(msg).not.toContain(S);
      try { resolveCallAgent(env.home, "fe-member"); } catch (e) { expect((e as Error).message).not.toContain(S); }
    });
  }
  it("size, symlink and alias keep their own fixed categories", () => {
    env = makeEnv();
    writeExec(`# x\n${"#".repeat(1024 * 1024 + 8)}\n`);
    expect(env.project().approvalError!.reason).toBe("file too large");
    fs.rmSync(execFile());
    fs.writeFileSync(path.join(env.root, "r.yaml"), "executors: {}\n");
    fs.symlinkSync(path.join(env.root, "r.yaml"), execFile());
    expect(env.project().approvalError!.reason).toMatch(/^not a regular file/);
    fs.rmSync(execFile());
    writeExec("a: &x 1\nexecutors: {}\nb: *x\n");
    expect(env.project().approvalError!.reason).toBe("YAML aliases are not allowed");
  });
});

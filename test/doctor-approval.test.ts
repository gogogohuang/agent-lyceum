import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProject } from "../src/config.js";
import { diagnoseProject, formatDoctor } from "../src/doctor.js";
import { diagnoseApproval } from "../src/doctor-approval.js";
import { setOsSandboxForTest } from "../src/policy.js";

// diagnoseProject without installed CLIs or child processes.
vi.mock("../src/process-runner.js", () => ({
  runInvocation: vi.fn(async (inv: { cmd: string; args: string[] }) => ({
    ok: true,
    text: inv.args.includes("--version") ? `${inv.cmd} fixture-version` : "--output-format --resume --settings --effort --json --sandbox --config",
  })),
}));
vi.setConfig({ testTimeout: 30_000 });

const here = path.dirname(fileURLToPath(import.meta.url));
const STEM_INVALID = "Approval executors configuration is invalid:";
let root: string;
let home: string;
let repo: string;
let tool: string;

const mk = (p: string, text = "", mode?: number): string => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (mode !== undefined) fs.chmodSync(p, mode);
  return p;
};
function setup(projects: Record<string, string>, globals = "  helper:\n    runtime: claude-code\n"): void {
  mk(path.join(home, "team.yaml"), `agents:\n${globals}`);
  for (const [name, extra] of Object.entries(projects)) {
    mk(path.join(home, "projects", name, "project.yaml"), `dir: ${repo}\nteam:\n  lead: dev\nagents:\n  dev:\n    runtime: claude-code\n${extra}`);
  }
}
const execYaml = (allow: string, command = `["${tool}"]`): string => `executors:\n  x:\n    command: ${command}\n    allow: ${allow}\n    timeout_sec: 5\n`;
const writeExec = (text: string): string => mk(path.join(home, "executors.yaml"), text);
const proj = (name: string) => resolveProject(home, name);
const opts = { sandboxAvailable: () => true, platform: "linux" as const, userHome: root };
const messages = (name: string, o = opts) => diagnoseApproval(proj(name), o).map((c) => `${c.level}: ${c.message}`);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doctor-approval-")));
  home = path.join(root, "home");
  repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  tool = mk(path.join(root, "exec", "bin", "tool"), "#!/bin/sh\nexit 0\n", 0o755);
});
afterEach(() => {
  setOsSandboxForTest(undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("default off", () => {
  it("an absent or valid-but-empty executors.yaml adds nothing: report and text are byte-identical", async () => {
    setup({ p: "" });
    const base = await diagnoseProject(proj("p"));
    const baseText = formatDoctor(base);
    for (const text of ["executors: {}\n", execYaml("[]"), ""]) {
      writeExec(text);
      const r = await diagnoseProject(proj("p"));
      expect(JSON.stringify(r)).toBe(JSON.stringify(base));
      expect(formatDoctor(r)).toBe(baseText);
      expect(diagnoseApproval(proj("p"), opts)).toEqual([]);
    }
    expect(base.checks.some((c) => c.subject === "approval")).toBe(false);
  });
  it("disabled mode does no inventory reads (a broken sibling project config is never opened)", () => {
    setup({ p: "", q: "" });
    const f = path.join(home, "projects", "q", "project.yaml");
    fs.rmSync(f);
    mk(f, "dir: [\n");
    writeExec(execYaml("[]"));
    expect(diagnoseApproval(proj("p"), opts)).toEqual([]);
  });
});

describe("invalid executors.yaml", () => {
  const variants: [string, () => void][] = [
    ["bad YAML", () => void writeExec("executors: [\n")],
    ["two-element command", () => void writeExec(execYaml("[]", `["${tool}", "--x"]`))],
    ["zero-element command", () => void writeExec(execYaml("[]", "[]"))],
    ["symlinked file", () => { mk(path.join(root, "real.yaml"), "executors: {}\n"); fs.symlinkSync(path.join(root, "real.yaml"), path.join(home, "executors.yaml")); }],
  ];
  for (const [name, make] of variants) {
    it(`${name} -> exactly one error, report not ok`, async () => {
      setup({ p: "" });
      make();
      const out = diagnoseApproval(proj("p"), opts);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ level: "error", subject: "approval" });
      expect(out[0]?.message.startsWith(STEM_INVALID)).toBe(true);
      expect(out[0]?.message).toContain("executors.yaml");
      const report = await diagnoseProject(proj("p"));
      expect(report.ok).toBe(false);
      expect(report.checks.filter((c) => c.subject === "approval")).toHaveLength(1);
    });
  }
  it("does not echo env values", () => {
    setup({ p: "" });
    writeExec(`executors:\n  x:\n    command: ["${tool}", "b"]\n    allow: []\n    timeout_sec: 5\n    env:\n      TOKEN: hunter2-secret\n`);
    expect(JSON.stringify(diagnoseApproval(proj("p"), opts))).not.toContain("hunter2");
  });
});

describe("enabled", () => {
  it("X enrolled gets premise errors; Y with the same agent name gets the clash warning and global lines only", () => {
    setup({
      p: "    fallback:\n      - runtime: codex\n    can_edit_agent_md: true\n    sandbox:\n      network: [example.com]\n",
      q: "    sandbox:\n      write: [\"" + path.join(home, "requests") + "\"]\n",
    });
    writeExec(execYaml(`[{project: p, agent: dev}]`));
    const x = messages("p");
    expect(x.some((m) => m.includes("Approval-enrolled candidate uses Codex"))).toBe(true);
    expect(x.some((m) => m.includes("permits sandbox.network"))).toBe(true);
    expect(x.some((m) => m.includes("can_edit_agent_md"))).toBe(true);
    expect(x.some((m) => m.includes("open_pr"))).toBe(true);
    expect(x.some((m) => m.includes("effective instance cap 1"))).toBe(true);
    const y = messages("q");
    expect(y.some((m) => m.includes("not approval-enrolled despite matching"))).toBe(true);
    expect(y.some((m) => m.includes("Approval-enrolled candidate") || m.includes("open_pr") || m.includes("instance cap"))).toBe(false);
    // The sibling's grant over requests/ shows in BOTH doctors (global containment).
    for (const list of [x, y]) expect(list.some((m) => m.includes("overlaps an agent writable range") && m.includes('project "q"'))).toBe(true);
  });
  it("end to end: X's full report fails on a sibling's sandbox.write covering requests/", async () => {
    setup({ p: "", q: `    sandbox:\n      write: ["${path.join(home, "requests")}"]\n` });
    writeExec(execYaml(`[{project: p, agent: dev}]`));
    setOsSandboxForTest(true);
    const r = await diagnoseProject(proj("p"));
    expect(r.ok).toBe(false);
    expect(r.checks.some((c) => c.level === "error" && c.message.includes("overlaps an agent writable range"))).toBe(true);
    expect(formatDoctor(r)).toContain("ERROR");
  });
  it("an enrolled call identity gets the agent premise checks", () => {
    setup({ p: "" }, "  helper:\n    runtime: claude-code\n    allow_web: search\n");
    writeExec(execYaml("[{call: helper}]"));
    const out = messages("p");
    expect(out.some((m) => m.includes("call/helper") && m.includes("allow_web=search"))).toBe(true);
    expect(out.some((m) => m.includes("open_pr"))).toBe(false);
    expect(out.some((m) => m.includes("Approval-enrolled candidate") && m.includes("p/dev"))).toBe(false);
  });
  it("is deterministic and free of duplicates", () => {
    setup({ p: "    fallback:\n      - runtime: codex\n" });
    writeExec(execYaml("[{project: p, agent: dev}, {call: helper}]"));
    const a = messages("p");
    expect(a).toEqual(messages("p"));
    expect(new Set(a).size).toBe(a.length);
  });
});

describe("boundary: nothing but doctor reads executors.yaml", () => {
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
  const users = (re: RegExp): string[] => files(path.join(here, "..", "src")).filter((f) => re.test(fs.readFileSync(f, "utf8"))).map((f) => path.basename(f)).sort();
  it("loadExecutors / parseExecutors are used only by their module and doctor-approval", () => {
    expect(users(/\b(loadExecutors|parseExecutors)\b/)).toEqual(["approval-executors.ts", "doctor-approval.ts"]);
  });
  it("applyEnrollment is used only by its module and the doctor premise module", () => {
    expect(users(/\bapplyEnrollment\b/)).toEqual(["approval-enrollment.ts", "doctor-approval-premises.ts"]);
  });
  it("resolveProject and doctor --resolved ignore even an invalid executors.yaml", () => {
    setup({ p: "" });
    const before = JSON.stringify(proj("p"));
    writeExec("executors: [\n");
    expect(JSON.stringify(proj("p"))).toBe(before);
    expect(Object.values(proj("p").agents).every((a) => a.enrolled === undefined)).toBe(true);
    const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
    const r = spawnSync(tsx, [path.join(here, "..", "src", "cli.ts"), "--home", home, "doctor", "--resolved", "-p", "p"], { encoding: "utf8", env: process.env });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("executors");
  });
});

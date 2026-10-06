import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Invocation } from "./adapters/types.js";
import type { ResolvedProject } from "./config.js";
import { inspectProjectLock, lockHolderAlive } from "./project-lock.js";
import { runInvocation } from "./process-runner.js";
import type { Runtime } from "./schema.js";
import { validateProject } from "./validate.js";
import { dirtyPaths, isGitRepo, resolveWorkspaceMode } from "./worktree.js";

export type Cap = "yes" | "no" | "unknown";

export interface RuntimeCapabilities {
  runtime: Runtime;
  binary: "found" | "missing";
  /** First line of `<cli> --version`, when it could be read. */
  version?: string;
  /** Prints machine-readable (JSON) results. */
  json: Cap;
  /** Can continue an earlier session. */
  resume: Cap;
  /** Offers a sandbox / permission settings to scope writes. */
  sandbox: Cap;
  /** Accepts a reasoning-effort setting. */
  effort: Cap;
  /** What could not be determined, and why. */
  notes: string[];
}

export interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  /** Per command; a CLI that does not answer in time leaves its capabilities `unknown`. Default 5000. */
  timeoutMs?: number;
}

const BINARY: Record<Runtime, string> = { "claude-code": "claude", codex: "codex" };

type Probe = { state: "ok" | "missing" | "timeout" | "failed"; out: string };

/** Run a read-only CLI query (`--version`, `--help`): bounded in time and output, never an agent task. */
async function query(cmd: string, args: string[], opts: ProbeOptions): Promise<Probe> {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lyceum-probe-"));
  const inv: Invocation = {
    cmd,
    args,
    stdin: "",
    cwd: os.tmpdir(),
    env: opts.env ?? process.env,
    parse: ({ stdout, stderr, code }) => ({ ok: code === 0, text: `${stdout}\n${stderr}`, error: code === 0 ? undefined : `exit ${code}` }),
  };
  try {
    const r = await runInvocation(inv, { timeoutSec: (opts.timeoutMs ?? 5000) / 1000, logDir, killGraceMs: 200, settleWaitMs: 200 });
    if (r.error?.includes("not found on PATH")) return { state: "missing", out: "" };
    if (r.timedOut) return { state: "timeout", out: "" };
    return { state: r.ok ? "ok" : "failed", out: r.text };
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}

const has = (help: string, re: RegExp): Cap => (re.test(help) ? "yes" : "no");

/** What this machine's CLI for `runtime` can do, read from `--version` and `--help` only. Anything it does not say stays `unknown`. */
export async function probeRuntime(runtime: Runtime, opts: ProbeOptions = {}): Promise<RuntimeCapabilities> {
  const cmd = BINARY[runtime];
  const caps: RuntimeCapabilities = { runtime, binary: "found", json: "unknown", resume: "unknown", sandbox: "unknown", effort: "unknown", notes: [] };
  const v = await query(cmd, ["--version"], opts);
  if (v.state === "missing") return { ...caps, binary: "missing", notes: [`${cmd} not found on PATH`] };
  if (v.state === "ok") caps.version = v.out.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 100);
  else caps.notes.push(v.state === "timeout" ? `\`${cmd} --version\` timed out` : `\`${cmd} --version\` failed`);

  const helpArgs = runtime === "codex" ? ["exec", "--help"] : ["--help"];
  const h = await query(cmd, helpArgs, opts);
  if (h.state !== "ok") {
    caps.notes.push(h.state === "timeout" ? `\`${cmd} ${helpArgs.join(" ")}\` timed out` : `\`${cmd} ${helpArgs.join(" ")}\` failed`);
    return caps;
  }
  if (runtime === "claude-code") {
    caps.json = has(h.out, /--output-format\b/);
    caps.resume = has(h.out, /--resume\b/);
    caps.sandbox = has(h.out, /--settings\b/) === "yes" ? "yes" : "unknown";
    caps.effort = has(h.out, /--effort\b/);
  } else {
    caps.json = has(h.out, /--json\b/);
    caps.sandbox = has(h.out, /--sandbox\b|\s-s,/);
    caps.effort = has(h.out, /--config\b|\s-c,/) === "yes" ? "yes" : "unknown"; // effort is passed as `-c model_reasoning_effort=...`
    const r = await query(cmd, ["exec", "resume", "--help"], opts);
    if (r.state === "ok") caps.resume = "yes";
    else if (r.state === "failed") caps.resume = "no";
    else caps.notes.push(`\`${cmd} exec resume --help\` timed out`);
  }
  return caps;
}

export interface DoctorCheck {
  level: "ok" | "info" | "warn" | "error";
  subject: string;
  message: string;
}

export interface DoctorReport {
  project: string;
  ok: boolean;
  checks: DoctorCheck[];
  runtimes: RuntimeCapabilities[];
}

/** What the team needs from each runtime versus what its CLI offers: explicit "no" is an error, "unknown" a warning. */
function judgeRuntimes(project: ResolvedProject, caps: RuntimeCapabilities[]): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  for (const c of caps) {
    const cmd = BINARY[c.runtime];
    const users = Object.values(project.agents).filter((a) => a.runtime === c.runtime);
    if (c.binary === "missing") {
      checks.push({ level: "error", subject: c.runtime, message: `${cmd} not found on PATH (needed by ${users.map((a) => a.name).join(", ")}).` });
      continue;
    }
    checks.push({ level: "ok", subject: c.runtime, message: `${cmd} ${c.version ?? "(version unknown)"}` });
    for (const n of c.notes) checks.push({ level: "warn", subject: c.runtime, message: n });
    const need = (cap: Cap, what: string, agents: string[]) => {
      if (!agents.length) return;
      if (cap === "no") checks.push({ level: "error", subject: c.runtime, message: `${agents.map((n) => `Agent "${n}"`).join(", ")}: the ${cmd} CLI does not support ${what}.` });
      else if (cap === "unknown") checks.push({ level: "warn", subject: c.runtime, message: `Whether the ${cmd} CLI supports ${what} is unknown (needed by ${agents.join(", ")}); agent-lyceum will try anyway.` });
    };
    need(c.json, "machine-readable (JSON) output, which every agent needs", users.map((a) => a.name));
    need(c.resume, "resuming sessions (resume: true)", users.filter((a) => a.resume).map((a) => `${a.name}`));
    need(c.effort, "a reasoning-effort setting (effort)", users.filter((a) => a.effort).map((a) => a.name));
  }
  return checks;
}

const runtimesUsed = (project: ResolvedProject): Runtime[] => [...new Set(Object.values(project.agents).map((a) => a.runtime).filter((r): r is Runtime => !!r))];

export async function probeProjectRuntimes(project: ResolvedProject, opts: ProbeOptions = {}): Promise<RuntimeCapabilities[]> {
  return Promise.all(runtimesUsed(project).map((r) => probeRuntime(r, opts)));
}

/** Before a run starts: what is explicitly unsupported (refuse) and what is merely unknown (warn). */
export async function preflightRuntimes(project: ResolvedProject, opts: ProbeOptions = {}): Promise<{ errors: string[]; warnings: string[] }> {
  const checks = judgeRuntimes(project, await probeProjectRuntimes(project, opts));
  return {
    errors: checks.filter((c) => c.level === "error").map((c) => c.message),
    warnings: checks.filter((c) => c.level === "warn").map((c) => c.message),
  };
}

/** Everything `agent-lyceum doctor` reports. Reads configuration and asks the CLIs for `--version`/`--help`; never runs an agent. */
export async function diagnoseProject(project: ResolvedProject, opts: ProbeOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const v = validateProject(project);
  for (const i of v.issues) checks.push({ level: i.level === "error" ? "error" : "warn", subject: "config", message: i.message });
  if (!v.issues.length) checks.push({ level: "ok", subject: "config", message: "Configuration is valid." });

  if (fs.existsSync(project.dir) && isGitRepo(project.dir)) {
    if (resolveWorkspaceMode(project.dispatcher) === "worktree") {
      const dirty = dirtyPaths(project.dir);
      if (dirty.length) checks.push({ level: "warn", subject: "git", message: `${dirty.length} uncommitted change(s) in ${project.dir}: a parallel run would refuse to start until they are committed or stashed.` });
      else checks.push({ level: "ok", subject: "git", message: "Repo is clean; parallel runs can start." });
    }
  }

  const lock = inspectProjectLock(project.paths.root);
  if (lock) {
    const alive = lockHolderAlive(lock);
    checks.push({
      level: "warn",
      subject: "lock",
      message: alive ? `A run is active: ${lock.run_id} (pid ${lock.pid}).` : `A stale run lock is left by ${lock.run_id} (pid ${lock.pid} is gone); \`agent-lyceum unlock --force\` clears it.`,
    });
  }

  const runtimes = await probeProjectRuntimes(project, opts);
  checks.push(...judgeRuntimes(project, runtimes));
  checks.push({ level: "info", subject: "login", message: "Login status is unknown: agent-lyceum does not read credentials, and the CLIs offer no read-only login check it can rely on." });
  return { project: project.name, ok: !checks.some((c) => c.level === "error"), checks, runtimes };
}

export function formatDoctor(r: DoctorReport): string {
  const mark = { ok: "ok   ", info: "info ", warn: "warn ", error: "ERROR" } as const;
  const lines = [`Project: ${r.project}`, ""];
  for (const c of r.checks) lines.push(`${mark[c.level]}  ${c.message}`);
  lines.push("", "Runtime capabilities (yes / no / unknown):");
  for (const c of r.runtimes) {
    lines.push(`  ${c.runtime}: ${c.binary === "missing" ? "not installed" : `${c.version ?? "version unknown"}; json ${c.json}, resume ${c.resume}, sandbox ${c.sandbox}, effort ${c.effort}`}`);
  }
  lines.push("", r.ok ? "No problems found." : "Problems found.");
  return lines.join("\n");
}

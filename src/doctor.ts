import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Invocation } from "./adapters/types.js";
import type { ResolvedProject } from "./config.js";
import { findOnPath } from "./fs-util.js";
import { tidyAdvice } from "./memory-tidy.js";
import { listRecords, RECORD_KINDS } from "./records.js";
import { listRunLocks, listUnreadableRunLocks, lockHolderAlive } from "./project-lock.js";
import { runInvocation } from "./process-runner.js";
import type { Runtime } from "./schema.js";
import { validateProject } from "./validate.js";
import { dirtyPaths, git, isolationBlocker } from "./worktree.js";

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
      if (!users.length) {
        // Only a fallback chain uses it: a backup that is not installed must not stop a run that works until the primary fails.
        const backups = Object.values(project.agents).filter((a) => a.fallback.some((f) => f.runtime === c.runtime));
        checks.push({ level: "warn", subject: c.runtime, message: `${cmd} not found on PATH (it is a fallback for ${backups.map((a) => a.name).join(", ")}).` });
      } else checks.push({ level: "error", subject: c.runtime, message: `${cmd} not found on PATH (needed by ${users.map((a) => a.name).join(", ")}).` });
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

/** Runtimes of the agents themselves; with `withFallback`, also those that only a fallback chain uses. */
const runtimesUsed = (project: ResolvedProject, withFallback: boolean): Runtime[] => [
  ...new Set(Object.values(project.agents).flatMap((a) => [a.runtime, ...(withFallback ? a.fallback.map((f) => f.runtime) : [])]).filter((r): r is Runtime => !!r)),
];

export async function probeProjectRuntimes(project: ResolvedProject, opts: ProbeOptions = {}, withFallback = false): Promise<RuntimeCapabilities[]> {
  return Promise.all(runtimesUsed(project, withFallback).map((r) => probeRuntime(r, opts)));
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

  const blocker = fs.existsSync(project.dir) ? isolationBlocker(project.dir) : undefined;
  if (fs.existsSync(project.dir)) {
    if (blocker) {
      checks.push({ level: "info", subject: "git", message: `Runs work directly in ${project.dir}, one agent at a time (${blocker}).` });
    } else {
      const dirty = dirtyPaths(project.dir);
      checks.push(
        dirty.length
          ? { level: "info", subject: "git", message: `${dirty.length} uncommitted change(s) in ${project.dir}: runs start from HEAD and do not see them.` }
          : { level: "ok", subject: "git", message: "git repo with a commit: runs and agents work in their own worktrees." },
      );
    }
  }

  if (fs.existsSync(project.dir) && !blocker) {
    const missing: string[] = [];
    if (!findOnPath("gh", opts.env?.PATH ?? process.env.PATH)) missing.push("`gh` is not on PATH");
    let remotes = "";
    try {
      remotes = git(project.dir, ["remote"]);
    } catch {
      /* no remotes readable */
    }
    if (!remotes.split(/\s+/).includes("origin")) missing.push("the repo has no `origin` remote");
    checks.push(
      missing.length
        ? { level: "info", subject: "pr", message: `A run cannot open a pull request (a lead asks for one with \`open_pr: true\`): ${missing.join("; ")}.` }
        : { level: "ok", subject: "pr", message: "`gh` and `origin` found: a run can open a pull request when the lead asks for one." },
    );
  }

  for (const lock of listRunLocks(project.paths.root)) {
    const alive = lockHolderAlive(lock);
    checks.push({
      level: "warn",
      subject: "lock",
      message: alive
        ? `A run is active: ${lock.run_id} (pid ${lock.pid}).`
        : `A stale run lock is left by ${lock.run_id} (pid ${lock.pid} is gone); \`agent-lyceum clear --lock ${lock.run_id} --force\` clears it.`,
    });
  }

  for (const id of listUnreadableRunLocks(project.paths.root)) {
    checks.push({ level: "warn", subject: "lock", message: `The lock file of run ${id} cannot be read; if no run is active, \`agent-lyceum clear --lock ${id} --force\` clears it.` });
  }

  for (const a of tidyAdvice(project)) checks.push({ level: "info", subject: "memory", message: `${a.agent}: ${a.reason}. Consider: agent-lyceum tidy -p ${project.name} --agent ${a.agent} (doctor only suggests; it never tidies).` });

  for (const kind of RECORD_KINDS) {
    const recs = listRecords(project, kind);
    const ids = new Set(recs.map((r) => r.id));
    for (const r of recs) {
      if (r.invalid) checks.push({ level: "warn", subject: "records", message: `${r.file}: ${r.invalid}` });
      for (const s of r.supersedes) if (!ids.has(s)) checks.push({ level: "warn", subject: "records", message: `${r.file}: supersedes "${s}", but no ${kind} entry has that id.` });
    }
  }

  const runtimes = await probeProjectRuntimes(project, opts, true);
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
  lines.push("", doctorFooter(r));
  return lines.join("\n");
}

/** One-line summary counted from the checks; `info` and `ok` never count. */
export function doctorFooter(r: DoctorReport): string {
  const errors = r.checks.filter((c) => c.level === "error").length;
  const warns = r.checks.filter((c) => c.level === "warn").length;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (errors > 0) {
    const parts = [plural(errors, "error"), ...(warns > 0 ? [plural(warns, "warning")] : [])];
    return `Problems found: ${parts.join(", ")} (marked ERROR${warns > 0 ? " / warn" : ""} above).`;
  }
  if (warns > 0) return `No errors; ${plural(warns, "warning")} to review (marked warn above).`;
  return "No problems found.";
}

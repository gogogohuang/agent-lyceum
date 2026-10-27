import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WakeInput, WakeResult, Invoker } from "./adapters/types.js";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { canonicalPath } from "./paths.js";

/**
 * `canonicalPath` for the sandbox check: a path that is missing (ENOENT/ENOTDIR) falls back to its nearest existing ancestor as
 * usual, but any other realpath error (EACCES, ELOOP, ...) throws so the invocation is refused (fail closed).
 */
function strictCanonical(p: string): string {
  for (let head = path.resolve(p); ; head = path.dirname(head)) {
    try {
      fs.realpathSync.native(head);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw new Error(`cannot resolve ${head} (${code ?? (e as Error).message})`);
      if (path.dirname(head) === head) break;
    }
  }
  return canonicalPath(p);
}
import {
  inboxDir,
  memoryDirs,
  osSandboxAvailable,
  outboxDir,
  recordsDir,
  repoDirFor,
  repoInstructionFiles,
  sandboxCapExcess,
  sandboxCaps,
  sandboxPathConflicts,
  sharedContextFiles,
  writePolicy,
  type SandboxPathConflict,
} from "./policy.js";

/** Where the `sandbox` and `sandbox-refused` events go: the run's log, or stderr for `call` (spec 25.8). */
export interface SandboxSink {
  event(name: string, fields: Record<string, unknown>): void;
}

export interface ProtectedPath {
  path: string;
  reason: string;
}

/** Whether `cwd` or a parent holds a `.git` entry (a directory, or the file of a linked worktree). */
function insideGitCheckout(cwd: string): boolean {
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/**
 * `git rev-parse --git-common-dir` of `cwd`, absolute; undefined when `cwd` is not in a git checkout. Fails closed: when it is a
 * checkout but the probe fails, throws, so the invocation is refused instead of running with the shared git dir unprotected.
 */
function gitCommonDir(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
    if (out) return path.resolve(cwd, out);
  } catch (e) {
    if (!insideGitCheckout(cwd)) return undefined;
    throw new Error(`cannot find the git common dir of ${cwd} (git rev-parse --git-common-dir failed: ${(e as Error).message.split("\n")[0]})`);
  }
  if (insideGitCheckout(cwd)) throw new Error(`cannot find the git common dir of ${cwd} (git rev-parse --git-common-dir printed nothing)`);
  return undefined;
}

/**
 * Everything a sandbox allowance must not reach (spec 25.4.3), canonical. `deep` adds the per-invocation items: the concrete
 * write policy's deny list, bound workspaces and the git common dir. The agent's own checkout is left out: it is already writable.
 */
export function protectedPathsFor(project: ResolvedProject, agent: ResolvedAgent, deep: boolean): ProtectedPath[] {
  const out: ProtectedPath[] = [];
  const add = (p: string | undefined, reason: string) => {
    if (p) out.push({ path: canonicalPath(p), reason });
  };
  add(project.home, "agent-lyceum home");
  add(project.dir, "project directory");
  add(path.join(os.homedir(), ".claude"), "Claude Code settings");
  add(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "Codex settings");
  for (const a of Object.values(project.agents)) {
    add(a.agentMd, `AGENT.md of ${a.name}`);
    for (const m of memoryDirs(a)) add(m, `memory of ${a.name}`);
    add(outboxDir(project, a.name), `outbox of ${a.name}`);
    add(inboxDir(project, a.name), `inbox of ${a.name}`);
  }
  for (const f of sharedContextFiles(project)) add(f, "shared context");
  for (const f of repoInstructionFiles(project)) add(f, "repo instruction file");
  add(recordsDir(project), "project records");
  if (!deep) return out;
  for (const d of writePolicy(project, agent).deny) add(d, "write-protected path");
  if (project.run) add(project.run.dir, "run directory");
  add(path.join(project.paths.root, "worktrees"), "worktrees root");
  const own = project.workspaces?.[agent.name];
  for (const [name, ws] of Object.entries(project.workspaces ?? {})) {
    if (name === agent.name) continue;
    add(ws.root, `workspace of ${name}`);
    add(ws.gitDir, `git dir of ${name}`);
    add(ws.commonDir, "git common dir");
  }
  // The agent's own checkout and git dir are already inside its write scope, so they are not listed; the shared common dir is.
  add(own?.commonDir ?? gitCommonDir(repoDirFor(project, agent.name)), "git common dir");
  return out;
}

export function describeConflict(agent: string, c: SandboxPathConflict, when: "load" | "invocation"): string {
  const suffix = when === "invocation" ? " (checked before invocation)" : "";
  const rel = c.relation === "equal" ? "is" : c.relation === "inside" ? "is inside" : "contains";
  return `agent ${agent}: sandbox.${c.key}[${c.index}] ${c.path} ${rel} protected path ${c.protectedPath} (${c.reason}); pick a different directory.${suffix}`;
}

/** Conflicts of one agent's `write`/`unix_sockets` with the protected set. */
export function sandboxConflictsOf(project: ResolvedProject, agent: ResolvedAgent, deep: boolean): SandboxPathConflict[] {
  const s = agent.sandbox;
  if (!s) return [];
  const entries = [
    ...s.write.map((p, index) => ({ key: "write" as const, index, path: canonicalPath(p) })),
    ...s.unixSockets.map((p, index) => ({ key: "unix_sockets" as const, index, path: canonicalPath(p) })),
  ];
  return sandboxPathConflicts(entries, protectedPathsFor(project, agent, deep));
}

/** Capability excess of each backup of `agent` over its primary (spec 25.9): `[candidate label, excess...]`. */
export function fallbackCapExcess(agent: ResolvedAgent): { label: string; excess: string[] }[] {
  if (!agent.sandbox || !agent.runtime) return [];
  const primary = sandboxCaps(agent, agent.runtime);
  const out: { label: string; excess: string[] }[] = [];
  for (const f of agent.fallback) {
    const excess = sandboxCapExcess(primary, sandboxCaps(agent, f.runtime));
    if (excess.length) out.push({ label: `${f.runtime}/${f.model || "(default model)"}`, excess });
  }
  return out;
}

/** The refusal, if any, for this invocation. */
export function sandboxRefusal(input: WakeInput, base: ResolvedAgent): { reason: string; path?: string } | undefined {
  const agent = input.agent;
  if (!agent.sandbox) return undefined;
  for (const p of [...agent.sandbox.write, ...agent.sandbox.unixSockets]) strictCanonical(p);
  const c = sandboxConflictsOf(input.project, agent, true)[0];
  if (c) return { reason: describeConflict(agent.name, c, "invocation"), path: c.path };
  const f = fallbackCapExcess(base)[0];
  if (f) return { reason: `agent ${base.name}: fallback ${f.label} would apply more sandbox allowance than the primary (${f.excess.join("; ")}) (checked before invocation)` };
  return undefined;
}

function applied(agent: ResolvedAgent): Record<string, string> {
  const caps = sandboxCaps(agent);
  const osOn = osSandboxAvailable();
  if (!osOn) return { write: agent.runtime === "claude-code" ? "tool-rules" : "none", network: "unrestricted", local_binding: "unrestricted", unix_sockets: "unrestricted" };
  return { write: "os", network: caps.network, local_binding: caps.localBinding ? "on" : "off", unix_sockets: caps.unixSockets ? "on" : "off" };
}

/**
 * The one entry every adapter invocation goes through (spec 25.4.3, 25.19.1): refuses (returning a `config` failure, never
 * throwing, never spawning) when an allowance reaches a protected path or a backup would widen them; otherwise records
 * the `sandbox` event and calls `invoke`. An agent without `sandbox`, and a policy-override wake, go straight through.
 */
export async function invokeWithSandboxChecks(invoke: Invoker, input: WakeInput, base: ResolvedAgent, sink: SandboxSink, attempt: number): Promise<WakeResult> {
  const agent = input.agent;
  if (!agent.sandbox || input.policy) return invoke(input);
  const refuse = (reason: string): WakeResult => ({ ok: false, text: "", exitCode: null, timedOut: false, error: `sandbox refused: ${reason}`, kind: "config" });
  try {
    const bad = sandboxRefusal(input, base);
    if (bad) {
      sink.event("sandbox-refused", { agent: agent.name, runtime: agent.runtime, reason: bad.reason, ...(bad.path ? { path: bad.path } : {}) });
      return refuse(bad.reason);
    }
    const s = agent.sandbox;
    sink.event("sandbox", {
      agent: agent.name,
      runtime: agent.runtime,
      model: agent.model,
      attempt,
      write: s.write.map(canonicalPath),
      network: s.network,
      local_binding: s.localBinding,
      unix_sockets: s.unixSockets.map(canonicalPath),
      applied: applied(agent),
    });
  } catch (e) {
    const reason = `${agent.name}: sandbox check failed: ${(e as Error).message}`;
    sink.event("sandbox-refused", { agent: agent.name, runtime: agent.runtime, reason });
    return refuse(reason);
  }
  return invoke(input);
}

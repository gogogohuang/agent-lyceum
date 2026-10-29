import fs from "node:fs";
import path from "node:path";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { findOnPath } from "./fs-util.js";
import { canonicalPath } from "./paths.js";

export type Level = "os" | "tool-rules" | "post-hoc" | "prompt-only" | "n/a";

export interface AgentEnforcement {
  agent: string;
  runtime: string;
  memory: Level;
  agentMd: Level;
  otherContext: Level;
  shared: Level;
  repoInstructions: Level;
  /** Absolute paths outside the repo this agent may write. */
  writablePaths: string[];
  notes: string[];
}

export interface WritePolicy {
  /** Directories the agent may write to (besides the repo). */
  allowDirs: string[];
  /** Directories the agent may read besides the repo and its writable ones, but must not write (the run's handoff notes, for everyone but the lead). */
  readDirs: string[];
  /** Individual files the agent may write (outside allowDirs). */
  allowFiles: string[];
  /** Files/dirs that must stay unwritable (checked even inside the repo). */
  deny: string[];
}

export function commonFile(project: ResolvedProject): string {
  return path.join(project.paths.shared, "common", "COMMON.md");
}

/** Durable decisions and lessons of the project, one file per entry: every member may write them, no longer only the lead. `.archive/` is tidy's output, never shown in prompts. */
export function recordsDir(project: ResolvedProject): string {
  return path.join(project.paths.shared, "common", "records");
}

export function recordsKindDir(project: ResolvedProject, kind: "decisions" | "lessons"): string {
  return path.join(recordsDir(project), kind);
}

/** The lead-maintained files shared by every run of the project. */
export function sharedContextFiles(project: ResolvedProject): string[] {
  return [commonFile(project)];
}

export function outboxDir(project: ResolvedProject, agent: string): string {
  return path.join(project.paths.outboxRoot, agent);
}

export function inboxDir(project: ResolvedProject, agent: string): string {
  return path.join(project.paths.inboxRoot, agent);
}

/** The repo's own CLAUDE.md/AGENTS.md: in the lead's worktree when it has one (concurrent runs), else in the repo. */
export function repoInstructionFiles(project: ResolvedProject): string[] {
  const dir = repoDirFor(project, project.lead);
  return [path.join(dir, "CLAUDE.md"), path.join(dir, "AGENTS.md")];
}

export function memoryDirs(a: ResolvedAgent): string[] {
  return [a.memory.global, a.memory.project, a.memory.task].filter((x): x is string => !!x);
}

/** Folder name of a run's handoff notes inside `task-memory/<run-id>/`. Agent names start with a letter or digit, so it cannot be an agent's own folder. */
export const SHARED_DIR = "_shared";

/** The run's handoff folder: read by every agent, written only by the lead. Undefined outside a run and for `call`. */
export function sharedDir(project: ResolvedProject): string | undefined {
  if (!project.run || project.solo === "call") return undefined;
  return path.join(project.paths.taskMemory, project.run.id, SHARED_DIR);
}

/** The index of the handoff notes: the one file shown in prompts, and the one the guard watches. */
export function sharedIndex(project: ResolvedProject): string | undefined {
  const dir = sharedDir(project);
  return dir ? path.join(dir, "MEMORY.md") : undefined;
}

const RUN_ENTRIES = ["state.json", "log.jsonl", "log.1.jsonl", "result.md", "task.md", "snapshots", "violations", "agents", "mail"];
const MAIL_ENTRIES = ["inbox", "claims", "attempts", "journal.jsonl"];

function entries(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The run records agents must not write. A run's mailboxes sit inside its run dir, and a deny on a parent would
 * beat the allow on an agent's own outbox, so the run dir is denied entry by entry instead of as a whole.
 */
function runDenyPaths(project: ResolvedProject): string[] {
  const runs = project.paths.runs;
  if (project.run?.layout !== "run") return [runs];
  const runDir = project.run.dir;
  const mail = path.join(runDir, "mail");
  const unique = (xs: string[]) => [...new Set(xs)];
  return unique([
    ...entries(runs).filter((e) => e !== project.run!.id).map((e) => path.join(runs, e)),
    ...[...RUN_ENTRIES, ...entries(runDir)].filter((e) => e !== "mail").map((e) => path.join(runDir, e)),
    ...[...MAIL_ENTRIES, ...entries(mail)].filter((e) => e !== "outbox").map((e) => path.join(mail, e)),
  ]);
}

/** The working directory of a wake-up that runs under a policy override: an empty dir, so nothing of the repo is writable by default. */
export const scratchCwd = (workDir: string): string => path.join(workDir, "cwd");

/** The repo directory this agent works in: its own worktree, or the main repo. */
export function repoDirFor(project: ResolvedProject, agent: string): string {
  return project.workspaces?.[agent]?.dir ?? project.dir;
}

export function projectAgentDir(project: ResolvedProject, agentName: string): string {
  return path.join(project.paths.agentsDir, agentName);
}

export function projectCommonDir(project: ResolvedProject): string {
  return path.join(project.paths.shared, "common");
}

function covers(dir: string, target: string): boolean {
  const root = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return target === dir || target.startsWith(root);
}

/** True when `agents/<name>/` does not contain another agent's persona, memory, inbox or outbox. */
export function ownAgentDirAllowed(project: ResolvedProject, agent: ResolvedAgent): boolean {
  const dir = projectAgentDir(project, agent.name);
  for (const other of Object.values(project.agents)) {
    if (other.name === agent.name) continue;
    const paths = [other.agentMd, inboxDir(project, other.name), outboxDir(project, other.name), ...memoryDirs(other)];
    if (paths.some((p) => covers(dir, p))) return false;
  }
  return true;
}

export function writePolicy(project: ResolvedProject, agent: ResolvedAgent): WritePolicy {
  const isLead = agent.name === project.lead && !project.solo;
  const ws = project.workspaces?.[agent.name];
  // A `call` has no mailboxes at all; a solo member of a run keeps its outbox to send `done`.
  const shared = sharedDir(project);
  const sharedIdx = sharedIndex(project);
  const mayWriteShared = !!shared && agent.name === project.lead;
  const ownDir = projectAgentDir(project, agent.name);
  const commonDir = projectCommonDir(project);
  const grantOwnDir = ownAgentDirAllowed(project, agent);
  const allowDirs = [
    ...memoryDirs(agent),
    ...(project.solo === "call" ? [] : [outboxDir(project, agent.name)]),
    ...(ws ? [ws.gitDir] : []),
    ...(shared && mayWriteShared ? [shared] : []),
    ...(grantOwnDir ? [ownDir] : []),
    commonDir,
    // Spec 25: canonical, because the OS sandbox compares real paths (`/tmp` is `/private/tmp` on macOS).
    ...(agent.sandbox?.write ?? []).map(canonicalPath),
  ];
  const allowFiles: string[] = [];
  if (isLead) allowFiles.push(...sharedContextFiles(project));
  if (mayWriteShared && sharedIdx) allowFiles.push(sharedIdx);
  if (agent.canEditAgentMd) {
    for (const a of Object.values(project.agents)) allowFiles.push(a.agentMd);
    allowFiles.push(...repoInstructionFiles(project));
  }

  const deny: string[] = [];
  const allowedFileSet = new Set(allowFiles);
  const grantedRoots = [...(grantOwnDir ? [ownDir] : []), commonDir];
  const addDeny = (p: string) => {
    if (!allowedFileSet.has(p) && !grantedRoots.some((d) => covers(d, p))) deny.push(p);
  };
  for (const a of Object.values(project.agents)) {
    addDeny(a.agentMd);
    if (a.name !== agent.name) for (const m of memoryDirs(a)) deny.push(m);
    if (a.name !== agent.name) deny.push(outboxDir(project, a.name));
    deny.push(inboxDir(project, a.name));
  }
  for (const f of sharedContextFiles(project)) addDeny(f);
  for (const f of repoInstructionFiles(project)) addDeny(f);
  if (shared && !mayWriteShared) deny.push(shared);
  deny.push(...runDenyPaths(project), project.paths.config, path.join(project.home, "team.yaml"));
  // In a worktree: other agents' checkouts are off limits, and so are this checkout's own copies of the protected files.
  for (const [name, other] of Object.entries(project.workspaces ?? {})) if (name !== agent.name) deny.push(other.root);
  if (ws) for (const f of ["CLAUDE.md", "AGENTS.md"]) addDeny(path.join(ws.dir, f));
  // Defence in depth: the dispatcher pins git's dir, common dir and work tree and never reads these, but a runtime that can
  // forbid single files should not let the agent rewrite them either. Codex cannot; it relies on the pinning alone.
  if (ws) deny.push(path.join(ws.root, ".git"), ...["commondir", "config.worktree", "gitdir"].map((f) => path.join(ws.gitDir, f)));

  return {
    allowDirs,
    readDirs: [...(shared && !mayWriteShared ? [shared] : []), ...Object.values(agent.sharedMemory ?? {})],
    allowFiles,
    deny: [...new Set(deny)],
  };
}

let sandboxProbe: boolean | undefined;
export function osSandboxAvailable(): boolean {
  if (sandboxProbe !== undefined) return sandboxProbe;
  if (process.platform === "darwin") sandboxProbe = true;
  else if (process.platform === "linux") sandboxProbe = findOnPath("bwrap");
  else sandboxProbe = false;
  return sandboxProbe;
}

/** Test seam: pretend the OS sandbox is (un)available; `undefined` re-probes the host. */
export function setOsSandboxForTest(available: boolean | undefined): void {
  sandboxProbe = available;
}

export function enforcementFor(project: ResolvedProject, agent: ResolvedAgent): AgentEnforcement {
  const pol = writePolicy(project, agent);
  const os = osSandboxAvailable();
  const notes: string[] = [];
  const isLeadAgent = agent.name === project.lead;
  let e: Omit<AgentEnforcement, "agent" | "runtime" | "writablePaths" | "notes">;

  if (agent.runtime === "claude-code") {
    const lvl: Level = os ? "os" : "tool-rules";
    e = { memory: lvl, agentMd: lvl, otherContext: lvl, shared: isLeadAgent ? "n/a" : lvl, repoInstructions: lvl };
    if (!os) notes.push("OS sandbox unavailable (Windows, or Linux without bubblewrap): Bash can bypass Edit rules.");
    if (!isLeadAgent && !os) notes.push("Without the OS sandbox Bash can write _shared; only the handoff index (_shared/MEMORY.md) is checked after each wake-up.");
  } else {
    const lvl: Level = os ? "os" : "prompt-only";
    e = { memory: lvl, agentMd: lvl, otherContext: lvl, shared: isLeadAgent ? "n/a" : os ? "os" : "post-hoc", repoInstructions: "post-hoc" };
    notes.push("Codex cannot forbid single files inside the repo; CLAUDE.md/AGENTS.md changes are detected and reverted after each wake-up.");
    if (!isLeadAgent && !os) notes.push("Without the OS sandbox only the handoff index (_shared/MEMORY.md) is checked after each wake-up; other files in _shared are not protected.");
    if (agent.canEditAgentMd) notes.push("can_edit_agent_md widens Codex writable roots to whole agent directories.");
  }

  if (agent.sandbox) notes.push(...sandboxNotes(agent, os));

  return {
    agent: agent.name,
    runtime: agent.runtime ?? "?",
    ...e,
    writablePaths: [...pol.allowDirs, ...pol.allowFiles.filter((f) => !f.startsWith(project.dir + path.sep) && !f.startsWith(repoDirFor(project, project.lead) + path.sep))],
    notes,
  };
}

/** Doctor lines for an agent's sandbox allowances (spec 25.7, 25.10): what is requested and what its runtime really applies. */
function sandboxNotes(agent: ResolvedAgent, os: boolean): string[] {
  const s = agent.sandbox;
  if (!s) return [];
  const claude = agent.runtime === "claude-code";
  const notes: string[] = [];
  if (!os) {
    notes.push(
      claude
        ? "no OS sandbox; sandbox.write changes Edit tool rules only; network/local_binding/unix_sockets have no effect."
        : "no OS sandbox; enforcement is prompt-only; sandbox allowances provide no OS enforcement.",
    );
  }
  if (s.network.length) {
    notes.push(`network: ${s.network.join(", ")} (${claude ? "claude-code: per-domain" : "codex: all hosts"})`);
    if (!claude) notes.push(`warn: sandbox.network is all-or-nothing on Codex: this agent may reach any host, not only ${s.network.join(", ")}.`);
  }
  if (s.localBinding) {
    notes.push(claude ? (process.platform === "darwin" ? "local_binding: on" : "local_binding: requested, no effect on this platform (macOS only)") : "local_binding: requested, not supported by codex");
    if (!claude) notes.push("warn: sandbox.local_binding has no Codex setting; whether a workspace-write sandbox lets it bind ports is unverified. sandbox.network turns on all network access, not only binding.");
  }
  if (s.unixSockets.length) {
    notes.push(`unix_sockets: ${s.unixSockets.map(canonicalPath).join(", ")} (${claude ? "applied" : "not applied by codex"})`);
    if (!claude) notes.push("warn: sandbox.unix_sockets has no per-socket Codex control; no setting emitted.");
  }
  for (const [key, list] of [["write", s.write], ["unix_sockets", s.unixSockets]] as const) {
    list.forEach((p, i) => {
      if (!fs.existsSync(p)) notes.push(`info: sandbox.${key}[${i}] ${p} does not exist yet`);
    });
  }
  return notes;
}

/** Can `agent` legitimately change this protected file? */
export function mayEditProtected(project: ResolvedProject, agent: ResolvedAgent, file: string): boolean {
  const pol = writePolicy(project, agent);
  if (pol.allowFiles.includes(file)) return true;
  const roots = [projectAgentDir(project, agent.name), projectCommonDir(project)].filter((d) => pol.allowDirs.includes(d));
  return roots.some((d) => file === d || file.startsWith(d + path.sep));
}

export type SandboxRelation = "equal" | "inside" | "contains";

export interface SandboxPathConflict {
  key: "write" | "unix_sockets";
  index: number;
  path: string;
  protectedPath: string;
  reason: string;
  relation: SandboxRelation;
}

const within = (parent: string, p: string) => p === parent || p.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** Pure (spec 25.4.3): which canonical sandbox paths equal, sit inside or contain a protected path. Callers canonicalize. */
export function sandboxPathConflicts(entries: { key: "write" | "unix_sockets"; index: number; path: string }[], protectedPaths: { path: string; reason: string }[]): SandboxPathConflict[] {
  const out: SandboxPathConflict[] = [];
  for (const e of entries) {
    for (const pp of protectedPaths) {
      const relation: SandboxRelation | undefined = e.path === pp.path ? "equal" : within(pp.path, e.path) ? "inside" : within(e.path, pp.path) ? "contains" : undefined;
      if (relation) out.push({ ...e, protectedPath: pp.path, reason: pp.reason, relation });
    }
  }
  return out;
}

/** What a runtime really applies of an agent's allowances (spec 25.9): the tuple a fallback must not exceed. */
export interface SandboxCaps {
  network: "none" | "domains" | "all";
  localBinding: boolean;
  unixSockets: boolean;
}

export const NETWORK_RANK = { none: 0, domains: 1, all: 2 } as const;

/** Without an OS sandbox nothing is applied, so every runtime is equal there. */
export function sandboxCaps(agent: ResolvedAgent, runtime: string | undefined = agent.runtime): SandboxCaps {
  const s = agent.sandbox;
  const none: SandboxCaps = { network: "none", localBinding: false, unixSockets: false };
  if (!s || !osSandboxAvailable()) return none;
  if (runtime === "claude-code") {
    return {
      network: s.network.length ? "domains" : "none",
      localBinding: s.localBinding && process.platform === "darwin",
      unixSockets: s.unixSockets.length > 0,
    };
  }
  return { ...none, network: s.network.length ? "all" : "none" };
}

/** Components in which `backup` applies more than `primary`, as `name: primary -> backup`. */
export function sandboxCapExcess(primary: SandboxCaps, backup: SandboxCaps): string[] {
  const out: string[] = [];
  if (NETWORK_RANK[backup.network] > NETWORK_RANK[primary.network]) out.push(`network: ${primary.network} -> ${backup.network}`);
  if (backup.localBinding && !primary.localBinding) out.push("local_binding: off -> on");
  if (backup.unixSockets && !primary.unixSockets) out.push("unix_sockets: off -> on");
  return out;
}

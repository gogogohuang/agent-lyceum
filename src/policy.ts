import fs from "node:fs";
import path from "node:path";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { findOnPath } from "./fs-util.js";
import { globStaticPrefix } from "./paths.js";

export type Level = "os" | "tool-rules" | "post-hoc" | "prompt-only" | "n/a";

export interface AgentEnforcement {
  agent: string;
  runtime: string;
  memory: Level;
  agentMd: Level;
  otherContext: Level;
  repoInstructions: Level;
  owns: Level;
  /** Absolute paths outside the repo this agent may write. */
  writablePaths: string[];
  notes: string[];
}

export interface WritePolicy {
  /** Directories the agent may write to (besides the repo). */
  allowDirs: string[];
  /** Individual files the agent may write (outside allowDirs). */
  allowFiles: string[];
  /** Files/dirs that must stay unwritable (checked even inside the repo). */
  deny: string[];
  /** Repo-relative globs the agent owns (only enforced when max_parallel > 1). */
  owns: string[];
  restrictRepoToOwns: boolean;
}

export function commonFile(project: ResolvedProject): string {
  return path.join(project.paths.shared, "common", "COMMON.md");
}

export function outboxDir(project: ResolvedProject, agent: string): string {
  return path.join(project.paths.outboxRoot, agent);
}

export function inboxDir(project: ResolvedProject, agent: string): string {
  return path.join(project.paths.inboxRoot, agent);
}

export function repoInstructionFiles(project: ResolvedProject): string[] {
  return [path.join(project.dir, "CLAUDE.md"), path.join(project.dir, "AGENTS.md")];
}

export function memoryDirs(a: ResolvedAgent): string[] {
  return [a.memory.global, a.memory.project, a.memory.task].filter((x): x is string => !!x);
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

/** The repo directory this agent works in: its own worktree, or the main repo. */
export function repoDirFor(project: ResolvedProject, agent: string): string {
  return project.workspaces?.[agent]?.dir ?? project.dir;
}

export function writePolicy(project: ResolvedProject, agent: ResolvedAgent): WritePolicy {
  const isLead = agent.name === project.lead && !project.solo;
  const ws = project.workspaces?.[agent.name];
  // A `call` has no mailboxes at all; a solo member of a run keeps its outbox to send `done`.
  const allowDirs = [...memoryDirs(agent), ...(project.solo === "call" ? [] : [outboxDir(project, agent.name)]), ...(ws ? [ws.gitDir] : [])];
  const allowFiles: string[] = [];
  if (isLead) allowFiles.push(commonFile(project));
  if (agent.canEditAgentMd) {
    for (const a of Object.values(project.agents)) allowFiles.push(a.agentMd);
    allowFiles.push(...repoInstructionFiles(project));
  }

  const deny: string[] = [];
  const allowedFileSet = new Set(allowFiles);
  const addDeny = (p: string) => {
    if (!allowedFileSet.has(p)) deny.push(p);
  };
  for (const a of Object.values(project.agents)) {
    addDeny(a.agentMd);
    if (a.name !== agent.name) for (const m of memoryDirs(a)) deny.push(m);
    if (a.name !== agent.name) deny.push(outboxDir(project, a.name));
    deny.push(inboxDir(project, a.name));
  }
  addDeny(commonFile(project));
  for (const f of repoInstructionFiles(project)) addDeny(f);
  deny.push(...runDenyPaths(project), project.paths.config, path.join(project.home, "team.yaml"));
  // In a worktree: other agents' checkouts are off limits, and so are this checkout's own copies of the protected files.
  for (const [name, other] of Object.entries(project.workspaces ?? {})) if (name !== agent.name) deny.push(other.root);
  if (ws) for (const f of ["CLAUDE.md", "AGENTS.md"]) addDeny(path.join(ws.dir, f));

  return {
    allowDirs,
    allowFiles,
    deny: [...new Set(deny)],
    owns: agent.owns,
    restrictRepoToOwns: project.dispatcher.max_parallel > 1 && agent.owns.length > 0 && !isLead,
  };
}

let sandboxProbe: boolean | undefined;
function osSandboxAvailable(): boolean {
  if (sandboxProbe !== undefined) return sandboxProbe;
  if (process.platform === "darwin") sandboxProbe = true;
  else if (process.platform === "linux") sandboxProbe = findOnPath("bwrap");
  else sandboxProbe = false;
  return sandboxProbe;
}

export function enforcementFor(project: ResolvedProject, agent: ResolvedAgent): AgentEnforcement {
  const pol = writePolicy(project, agent);
  const os = osSandboxAvailable();
  const notes: string[] = [];
  const parallel = project.dispatcher.max_parallel > 1;
  let e: Omit<AgentEnforcement, "agent" | "runtime" | "writablePaths" | "notes">;

  if (agent.runtime === "claude-code") {
    const lvl: Level = os ? "os" : "tool-rules";
    e = { memory: lvl, agentMd: lvl, otherContext: lvl, repoInstructions: lvl, owns: parallel ? "tool-rules" : "n/a" };
    if (!os) notes.push("OS sandbox unavailable (Windows, or Linux without bubblewrap): Bash can bypass Edit rules.");
  } else {
    const lvl: Level = os ? "os" : "prompt-only";
    e = { memory: lvl, agentMd: lvl, otherContext: lvl, repoInstructions: "post-hoc", owns: parallel ? "prompt-only" : "n/a" };
    notes.push("Codex cannot forbid single files inside the repo; CLAUDE.md/AGENTS.md changes are detected and reverted after each wake-up.");
    if (agent.canEditAgentMd) notes.push("can_edit_agent_md widens Codex writable roots to whole agent directories.");
  }

  return {
    agent: agent.name,
    runtime: agent.runtime ?? "?",
    ...e,
    writablePaths: [...pol.allowDirs, ...pol.allowFiles.filter((f) => !f.startsWith(project.dir + path.sep))],
    notes,
  };
}

/** Static directory prefixes (absolute) of an agent's `owns` globs. */
export function ownsDirs(project: ResolvedProject, agent: ResolvedAgent): string[] {
  return agent.owns.map((g) => path.join(project.dir, globStaticPrefix(g)));
}

/** Can `agent` legitimately change this protected file? */
export function mayEditProtected(project: ResolvedProject, agent: ResolvedAgent, file: string): boolean {
  return writePolicy(project, agent).allowFiles.includes(file);
}

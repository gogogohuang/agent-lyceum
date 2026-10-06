import type { ResolvedAgent, ResolvedProject } from "../config.js";
import type { AgentWorkspace } from "../worktree.js";

export interface WakeInput {
  project: ResolvedProject;
  agent: ResolvedAgent;
  /** Scratch dir for generated per-agent files (inside the run dir, never in the repo). */
  workDir: string;
  systemPrompt: string;
  userPrompt: string;
  sessionId?: string;
  timeoutSec: number;
  /** The agent's own git worktree, when it does not work in the main repo. */
  workspace?: AgentWorkspace;
  /** Stop the wake-up (kill its process tree) when this fires. */
  signal?: AbortSignal;
  /** Where the full stdout/stderr of this invocation are written. */
  logDir?: string;
}

export interface WakeResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  outputTokens?: number;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  /** Stopped because the run was cancelled, not because it failed. */
  cancelled?: boolean;
}

export type Parsed = {
  ok: boolean;
  text: string;
  sessionId?: string;
  outputTokens?: number;
  error?: string;
};

/** Reads a runtime's stdout line by line while it runs, keeping only what it needs. */
export interface StreamParser {
  line(text: string): void;
  finish(out: { code: number | null; stdoutTail: string; stderrTail: string }): Parsed;
}

export interface Invocation {
  cmd: string;
  args: string[];
  stdin: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Interpret the finished process from its (tail of) output. Used when `stream` is absent. */
  parse(out: { stdout: string; stderr: string; code: number | null }): Parsed;
  /** Preferred over `parse`: sees every stdout line as it is read, so memory stays bounded however much the runtime prints. */
  stream?(): StreamParser;
}

export type Invoker = (input: WakeInput) => Promise<WakeResult>;

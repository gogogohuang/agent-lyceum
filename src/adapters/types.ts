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
}

export interface WakeResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  outputTokens?: number;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

export interface Invocation {
  cmd: string;
  args: string[];
  stdin: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Interpret the finished process. */
  parse(out: { stdout: string; stderr: string; code: number | null }): {
    ok: boolean;
    text: string;
    sessionId?: string;
    outputTokens?: number;
    error?: string;
  };
}

export type Invoker = (input: WakeInput) => Promise<WakeResult>;

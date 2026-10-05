import type { ResolvedAgent, ResolvedProject } from "../config.js";

export interface WakeInput {
  project: ResolvedProject;
  agent: ResolvedAgent;
  /** Scratch dir for generated per-agent files (inside the run dir, never in the repo). */
  workDir: string;
  systemPrompt: string;
  userPrompt: string;
  sessionId?: string;
  timeoutSec: number;
}

export interface WakeResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  costUsd?: number;
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
    costUsd?: number;
    error?: string;
  };
}

export type Invoker = (input: WakeInput) => Promise<WakeResult>;

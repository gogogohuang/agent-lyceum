import path from "node:path";
import { runInvocation } from "../process-runner.js";
import { buildClaudeInvocation } from "./claude.js";
import { buildCodexInvocation } from "./codex.js";
import type { Invocation, Invoker, WakeInput } from "./types.js";

export function buildInvocation(input: WakeInput): Invocation {
  switch (input.agent.runtime) {
    case "claude-code":
      return buildClaudeInvocation(input);
    case "codex":
      return buildCodexInvocation(input);
    default:
      throw new Error(`Agent "${input.agent.name}" has no runtime`);
  }
}

export const realInvoker: Invoker = (input) =>
  runInvocation(buildInvocation(input), {
    timeoutSec: input.timeoutSec,
    signal: input.signal,
    logDir: input.logDir ?? path.join(input.workDir, "logs"),
  });

export { runInvocation };

export type { Invoker, WakeInput, WakeResult } from "./types.js";

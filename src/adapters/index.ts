import path from "node:path";
import { runInvocation } from "../process-runner.js";
import { buildClaudeInvocation } from "./claude.js";
import { buildCodexInvocation } from "./codex.js";
import { buildCursorInvocation, CursorPromptTooLongError } from "./cursor.js";
import type { Invocation, Invoker, WakeInput } from "./types.js";

export function buildInvocation(input: WakeInput): Invocation {
  switch (input.agent.runtime) {
    case "claude-code":
      return buildClaudeInvocation(input);
    case "codex":
      return buildCodexInvocation(input);
    case "cursor":
      return buildCursorInvocation(input);
    default:
      throw new Error(`Agent "${input.agent.name}" has no runtime`);
  }
}

export const realInvoker: Invoker = async (input) => {
  let inv: Invocation;
  try {
    inv = buildInvocation(input);
  } catch (e) {
    // kind "config" stops at once and is not retried with backoff; the same oversized prompt would fail again.
    if (e instanceof CursorPromptTooLongError) return { ok: false, text: "", exitCode: null, timedOut: false, error: e.message, kind: "config" };
    throw e;
  }
  return runInvocation(inv, {
    timeoutSec: input.timeoutSec,
    signal: input.signal,
    logDir: input.logDir ?? path.join(input.workDir, "logs"),
  });
};

export { runInvocation };

export type { Invoker, WakeInput, WakeResult } from "./types.js";

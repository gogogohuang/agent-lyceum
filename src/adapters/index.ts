import { spawn } from "node:child_process";
import { buildClaudeInvocation } from "./claude.js";
import { buildCodexInvocation } from "./codex.js";
import type { Invocation, Invoker, WakeInput, WakeResult } from "./types.js";

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

/** Run an invocation as a child process with a hard timeout. */
export function runInvocation(inv: Invocation, timeoutSec: number): Promise<WakeResult> {
  return new Promise((resolve) => {
    const child = spawn(inv.cmd, inv.args, { cwd: inv.cwd, env: inv.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (r: WakeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutSec * 1000);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      const hint = (e as NodeJS.ErrnoException).code === "ENOENT" ? ` ("${inv.cmd}" not found on PATH)` : "";
      finish({ ok: false, text: "", exitCode: null, timedOut: false, error: `${e.message}${hint}` });
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish({ ok: false, text: "", exitCode: code, timedOut: true, error: `timed out after ${timeoutSec}s` });
        return;
      }
      const parsed = inv.parse({ stdout, stderr, code });
      finish({ ...parsed, exitCode: code, timedOut: false });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(inv.stdin);
  });
}

export const realInvoker: Invoker = (input) => runInvocation(buildInvocation(input), input.timeoutSec);

export type { Invoker, WakeInput, WakeResult } from "./types.js";

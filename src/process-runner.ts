import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Invocation, StreamParser, WakeResult } from "./adapters/types.js";

/** Most output kept in memory per stream; the rest only goes to the log files. */
export const TAIL_BYTES = 64 * 1024;
/** A stdout line longer than this is not offered to the adapter's parser (it is still logged). */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface RunnerOptions {
  timeoutSec: number;
  signal?: AbortSignal;
  /** `stdout.log` and `stderr.log` of this invocation are written here, in full. */
  logDir: string;
  /** How long a stopping process gets between SIGTERM and SIGKILL. Default 5000. */
  killGraceMs?: number;
  /** How long to wait for output pipes to close after the process is gone or killed, before giving up on them. Default 1000. */
  settleWaitMs?: number;
}

class Tail {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > TAIL_BYTES * 2) this.buf = this.buf.subarray(this.buf.length - TAIL_BYTES);
  }
  text(): string {
    return (this.buf.length > TAIL_BYTES ? this.buf.subarray(this.buf.length - TAIL_BYTES) : this.buf).toString("utf8");
  }
}

/** Fallback for adapters without `stream`: keep the head of stdout (bounded) for their `parse`. */
const FALLBACK_STDOUT_BYTES = 8 * 1024 * 1024;

function endStream(s: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      s.destroy();
      resolve();
    }, 2000);
    t.unref();
    s.end(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Run an invocation as a child process in its own process group, with a timeout, cancellation, bounded memory
 * and a bounded finish: whatever the runtime and its descendants do with the output pipes, this settles once,
 * and the whole process tree is gone by then (SIGTERM, then SIGKILL after `killGraceMs`).
 */
export function runInvocation(inv: Invocation, opts: RunnerOptions): Promise<WakeResult> {
  const grace = opts.killGraceMs ?? 5000;
  const settleWait = opts.settleWaitMs ?? 1000;
  const cancelled: WakeResult = { ok: false, text: "", exitCode: null, timedOut: false, cancelled: true, error: "cancelled" };
  if (opts.signal?.aborted) return Promise.resolve(cancelled);

  return new Promise((resolve) => {
    fs.mkdirSync(opts.logDir, { recursive: true });
    const outLog = fs.createWriteStream(path.join(opts.logDir, "stdout.log"));
    const errLog = fs.createWriteStream(path.join(opts.logDir, "stderr.log"));
    outLog.on("error", () => {});
    errLog.on("error", () => {});

    const child = spawn(inv.cmd, inv.args, { cwd: inv.cwd, env: inv.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    const stdoutTail = new Tail();
    const stderrTail = new Tail();
    const parser: StreamParser | undefined = inv.stream?.();
    let fallback = Buffer.alloc(0);

    let exitCode: number | null | undefined;
    let reason: "timeout" | "cancel" | undefined;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch {
        /* nothing left to signal */
      }
    };

    const finish = (spawnError?: Error) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener("abort", onAbort);
      killGroup("SIGKILL"); // whatever of the tree is still around
      child.stdout?.destroy();
      child.stderr?.destroy();
      void Promise.all([endStream(outLog), endStream(errLog)]).then(() => {
        if (spawnError) {
          const hint = (spawnError as NodeJS.ErrnoException).code === "ENOENT" ? ` ("${inv.cmd}" not found on PATH)` : "";
          return resolve({ ok: false, text: "", exitCode: null, timedOut: false, error: `${spawnError.message}${hint}` });
        }
        if (reason === "cancel") return resolve({ ...cancelled, exitCode: exitCode ?? null });
        if (reason === "timeout") return resolve({ ok: false, text: "", exitCode: exitCode ?? null, timedOut: true, error: `timed out after ${opts.timeoutSec}s` });
        const parsed = parser
          ? parser.finish({ code: exitCode ?? null, stdoutTail: stdoutTail.text(), stderrTail: stderrTail.text() })
          : inv.parse({ stdout: fallback.length ? fallback.toString("utf8") : stdoutTail.text(), stderr: stderrTail.text(), code: exitCode ?? null });
        resolve({ ...parsed, exitCode: exitCode ?? null, timedOut: false });
      });
    };

    /** Stop the whole tree, then give up on the pipes shortly after, whatever still holds them. */
    const stop = (why: "timeout" | "cancel") => {
      if (settled || reason) return;
      reason = why;
      killGroup("SIGTERM");
      timers.push(setTimeout(() => killGroup("SIGKILL"), grace));
      timers.push(setTimeout(() => finish(), grace + settleWait));
    };

    function onAbort() {
      stop("cancel");
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(() => stop("timeout"), opts.timeoutSec * 1000));

    // stdout: log in full with backpressure, keep a tail, and give each line to the adapter
    let partial = "";
    let skipping = false;
    const onLine = (l: string) => parser?.line(l);
    child.stdout.on("data", (chunk: Buffer) => {
      if (!outLog.write(chunk)) {
        child.stdout.pause();
        outLog.once("drain", () => child.stdout.resume());
      }
      stdoutTail.push(chunk);
      if (!parser && fallback.length < FALLBACK_STDOUT_BYTES) fallback = Buffer.concat([fallback, chunk]);
      if (!parser) return;
      let text = partial + chunk.toString("utf8");
      partial = "";
      let nl: number;
      while ((nl = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, nl).replace(/\r$/, "");
        text = text.slice(nl + 1);
        if (skipping) skipping = false;
        else if (line) onLine(line);
      }
      if (skipping || text.length > MAX_LINE_BYTES) {
        skipping = true; // drop the rest of an enormous line
      } else partial = text;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!errLog.write(chunk)) {
        child.stderr.pause();
        errLog.once("drain", () => child.stderr.resume());
      }
      stderrTail.push(chunk);
    });

    child.on("error", (e) => finish(e));
    child.on("exit", (code) => {
      exitCode = code;
      // The runtime is gone. Normally its pipes close at once; if a descendant still holds them, stop waiting soon.
      timers.push(setTimeout(() => finish(), settleWait));
    });
    child.on("close", () => {
      if (partial && parser && !skipping) onLine(partial.replace(/\r$/, ""));
      partial = "";
      finish();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(inv.stdin);
  });
}

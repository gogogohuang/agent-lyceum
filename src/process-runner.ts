import { spawn, spawnSync } from "node:child_process";
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
 * Runtimes that are running right now, with the descendants seen so far, so an exiting agent-lyceum can take them with it.
 * A descendant that left the process group (setsid, daemon) is only found by parent links while its parent is alive, so a
 * shared timer samples the process table while any runtime is registered. Remaining gap: a child that escapes and
 * outlives its parent within one sampling interval is never seen.
 */
const live = new Map<number, Set<number>>();
let exitHook = false;
let sampler: NodeJS.Timeout | undefined;
let samplerMs = 2000;

/** Parent -> children from one `ps` run, or undefined when it fails or hangs (SIGKILL on timeout: a ps that ignores SIGTERM must not block, even in the exit hook). */
function processTable(): Map<number, number[]> | undefined {
  if (process.platform === "win32") return undefined;
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2000, killSignal: "SIGKILL" });
  if (ps.status !== 0 || !ps.stdout) return undefined;
  const kids = new Map<number, number[]>();
  for (const line of ps.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  return kids;
}

function below(kids: Map<number, number[]> | undefined, root: number): number[] {
  const out: number[] = [];
  if (!kids) return out;
  for (let todo = [root]; todo.length; ) {
    const next: number[] = [];
    for (const p of todo) {
      for (const k of kids.get(p) ?? []) {
        if (out.includes(k)) continue;
        out.push(k);
        next.push(k);
      }
    }
    todo = next;
  }
  return out;
}

/** Pids below `root` (children, grandchildren, ...) by parent links; catches descendants that left the process group (setsid, daemons). */
export function descendantsOf(root: number): number[] {
  return below(processTable(), root);
}

/** Record the current descendants of every live runtime (one `ps` for all). */
function sample(): void {
  if (!live.size) return;
  const kids = processTable();
  for (const [pid, seen] of live) for (const d of below(kids, pid)) seen.add(d);
}

function register(pid: number): void {
  live.set(pid, new Set());
  if (!exitHook) {
    exitHook = true;
    process.on("exit", killAllRunning); // process.exit() and crashes must not leave detached runtimes behind
  }
  if (!sampler) {
    sampler = setInterval(sample, samplerMs);
    sampler.unref();
  }
}

function unregister(pid: number): void {
  live.delete(pid);
  if (!live.size && sampler) {
    clearInterval(sampler);
    sampler = undefined;
  }
}

/** Sampling interval of the descendant timer (default 2000 ms); for tests. Takes effect for the next timer. */
export function setSamplerIntervalMs(ms: number): void {
  samplerMs = ms;
}

/** Whether the descendant timer is running (for tests). */
export function samplerActive(): boolean {
  return sampler !== undefined;
}

function signalPid(pid: number, sig: NodeJS.Signals, group: boolean): void {
  try {
    process.kill(group && process.platform !== "win32" ? -pid : pid, sig);
  } catch {
    /* already gone */
  }
}

/** Signal the runtime's group, the descendants recorded earlier that are still in the process table, and its current descendants. */
function killTree(pid: number, sig: NodeJS.Signals): void {
  const kids = processTable();
  const seen = live.get(pid) ?? new Set<number>();
  const now = below(kids, pid);
  const present = kids ? new Set([...kids.values()].flat()) : undefined; // without a table, trust the record
  for (const d of now) seen.add(d);
  signalPid(pid, sig, true);
  for (const d of seen) if (!present || present.has(d)) signalPid(d, sig, false);
}

/** How many runtimes are registered as running (for tests). */
export function runningCount(): number {
  return live.size;
}

/** Synchronously SIGKILL every runtime still running, with the descendants seen when it was started or last checked. Used when agent-lyceum itself is going away. */
export function killAllRunning(): void {
  for (const pid of [...live.keys()]) {
    killTree(pid, "SIGKILL");
    unregister(pid);
  }
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
    if (child.pid !== undefined) register(child.pid);
    const stdoutTail = new Tail();
    const stderrTail = new Tail();
    const parser: StreamParser | undefined = inv.stream?.();
    let fallback = Buffer.alloc(0);

    let exitCode: number | null | undefined;
    let reason: "timeout" | "cancel" | undefined;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid !== undefined) killTree(child.pid, sig);
    };

    const finish = (spawnError?: Error) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener("abort", onAbort);
      killGroup("SIGKILL"); // whatever of the tree is still around
      if (child.pid !== undefined) unregister(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      void Promise.all([endStream(outLog), endStream(errLog)]).then(() => {
        if (spawnError) {
          const hint = (spawnError as NodeJS.ErrnoException).code === "ENOENT" ? ` ("${inv.cmd}" not found on PATH)` : "";
          // a missing binary is a crash the chain may route around (the next candidate can be another CLI); other spawn errors stay unclassified
          const kind = hint ? ("crash" as const) : ("unknown" as const);
          return resolve({ ok: false, text: "", exitCode: null, timedOut: false, error: `${spawnError.message}${hint}`, kind });
        }
        if (reason === "cancel") return resolve({ ...cancelled, exitCode: exitCode ?? null });
        if (reason === "timeout") return resolve({ ok: false, text: "", exitCode: exitCode ?? null, timedOut: true, error: `timed out after ${opts.timeoutSec}s`, kind: "timeout" });
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
      for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n")) {
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

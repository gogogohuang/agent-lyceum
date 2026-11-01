import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./fs-util.js";
import { killTree, register, unregister } from "./process-runner.js";
import type { VerifyCommandRecord, VerifyRecord } from "./run-store.js";
import type { VerifySettings } from "./schema.js";

/** Most output kept in a verify log; a longer output keeps its end and says so at the top. */
export const VERIFY_LOG_BYTES = 1024 * 1024;
/** Most output of one command put into the mail to the lead and into the report. */
export const VERIFY_TAIL_BYTES = 4096;
export const VERIFY_DIR = "verify";

/** The last `max` bytes of `buf` as text, never starting in the middle of a UTF-8 character. */
export function tailText(buf: Buffer, max: number): string {
  if (buf.length <= max) return buf.toString("utf8");
  let start = buf.length - max;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

export interface RunCommandOptions {
  cwd: string;
  timeoutSec: number;
  signal?: AbortSignal;
  /** Called with each chunk of output as it arrives (a readiness barrier for tests). */
  onOutput?: (chunk: Buffer) => void;
  /** Between SIGTERM and SIGKILL. Default 5000. */
  killGraceMs?: number;
  /** How long to wait for the output pipes after the shell is gone. Default 1000. */
  settleWaitMs?: number;
}

export type CommandResult = { cancelled: true } | { cancelled: false; exit: number | null; ms: number; timedOut: boolean; error?: string; output: Buffer };

/**
 * Run one command with `sh -c` in its own process group: stdin closed, output (both streams, in arrival order) kept in memory up to
 * 2 x VERIFY_LOG_BYTES. Timeout and cancel stop the whole tree (SIGTERM, SIGKILL after `killGraceMs`); this settles once, whatever
 * still holds the pipes. The child is registered with the process runner, so `killAllRunning` takes it down when agent-lyceum exits.
 */
export function runCommand(run: string, opts: RunCommandOptions): Promise<CommandResult> {
  const grace = opts.killGraceMs ?? 5000;
  const settleWait = opts.settleWaitMs ?? 1000;
  if (opts.signal?.aborted) return Promise.resolve({ cancelled: true });
  return new Promise((resolve) => {
    const started = Date.now();
    let child: ChildProcess;
    try {
      child = spawn("sh", ["-c", run], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (e) {
      return resolve({ cancelled: false, exit: null, ms: 0, timedOut: false, error: (e as Error).message, output: Buffer.alloc(0) });
    }
    if (child.pid !== undefined) register(child.pid);
    let buf: Buffer = Buffer.alloc(0);
    let dropped = 0;
    let exit: number | null = null;
    let reason: "timeout" | "cancel" | undefined;
    let spawnError: string | undefined;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const kill = (sig: NodeJS.Signals) => {
      if (child.pid !== undefined) killTree(child.pid, sig);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener("abort", onAbort);
      kill("SIGKILL"); // whatever of the tree is still around
      if (child.pid !== undefined) unregister(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      // An abort that came after the process was gone but before the result was judged also withholds the verdict.
      if (reason === "cancel" || opts.signal?.aborted) return resolve({ cancelled: true });
      const out = dropped ? Buffer.concat([Buffer.from(`[agent-lyceum: ${dropped} byte(s) of earlier output dropped]\n`), buf]) : buf;
      resolve({ cancelled: false, exit, ms: Date.now() - started, timedOut: reason === "timeout", ...(spawnError ? { error: spawnError } : {}), output: out });
    };
    const stop = (why: "timeout" | "cancel") => {
      if (settled) return;
      // Cancel outranks a timeout that is still cleaning up: the verdict is withheld either way, and the tree is already being stopped.
      if (reason) {
        if (why === "cancel") reason = "cancel";
        return;
      }
      reason = why;
      kill("SIGTERM");
      timers.push(setTimeout(() => kill("SIGKILL"), grace));
      timers.push(setTimeout(finish, grace + settleWait));
    };
    function onAbort() {
      stop("cancel");
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(() => stop("timeout"), opts.timeoutSec * 1000));
    const onData = (chunk: Buffer) => {
      opts.onOutput?.(chunk);
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > VERIFY_LOG_BYTES * 2) {
        let start = buf.length - VERIFY_LOG_BYTES;
        while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
        dropped += start;
        buf = buf.subarray(start);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      spawnError = (e as NodeJS.ErrnoException).code === "ENOENT" ? `${e.message} (sh or the working directory ${opts.cwd} not found)` : e.message;
      finish();
    });
    child.on("exit", (code) => {
      exit = code;
      timers.push(setTimeout(finish, settleWait)); // a descendant may still hold the pipes
    });
    child.on("close", finish);
  });
}

/** The output as it goes into the log file: at most VERIFY_LOG_BYTES, with a first line saying so when the start was cut. */
export function logBody(output: Buffer): Buffer {
  if (output.length <= VERIFY_LOG_BYTES) return output;
  let start = output.length - VERIFY_LOG_BYTES;
  while (start < output.length && (output[start]! & 0xc0) === 0x80) start++;
  return Buffer.concat([Buffer.from(`[agent-lyceum: output truncated; the first ${start} byte(s) are not kept, the last ${output.length - start} follow]\n`), output.subarray(start)]);
}

/** The next free log number: above every record and every file already in `verify/`, so no attempt (also not an unrecorded one from a crash) is overwritten. */
export function nextLogNumber(runDir: string, records: VerifyRecord[] | undefined): number {
  let max = 0;
  for (const r of records ?? []) for (const c of r.commands) max = Math.max(max, Number(/^verify\/(\d+)-/.exec(c.log)?.[1] ?? 0));
  try {
    for (const f of fs.readdirSync(path.join(runDir, VERIFY_DIR))) max = Math.max(max, Number(/^(\d+)-/.exec(f)?.[1] ?? 0));
  } catch {
    /* no verify dir yet */
  }
  return max + 1;
}

export type VerifyOutcome = { cancelled: true } | { cancelled: false; passed: boolean; commands: VerifyCommandRecord[]; tails: Record<string, string>; failed?: VerifyCommandRecord };

export interface VerifyHooks {
  start?: (name: string) => void;
  end?: (c: VerifyCommandRecord) => void;
}

/** Run the commands in order, stopping at the first failure (fail-fast). Cancelling gives no verdict. */
export async function runVerify(verify: VerifySettings, runDir: string, records: VerifyRecord[] | undefined, opts: { cwd: string; signal?: AbortSignal; killGraceMs?: number; settleWaitMs?: number }, hooks: VerifyHooks = {}): Promise<VerifyOutcome> {
  const commands: VerifyCommandRecord[] = [];
  const tails: Record<string, string> = {};
  let n = nextLogNumber(runDir, records);
  for (const c of verify.commands) {
    const rel = `${VERIFY_DIR}/${n++}-${c.name}.log`;
    hooks.start?.(c.name);
    const r = await runCommand(c.run, { cwd: opts.cwd, timeoutSec: c.timeout_sec, signal: opts.signal, killGraceMs: opts.killGraceMs, settleWaitMs: opts.settleWaitMs });
    if (r.cancelled) return { cancelled: true };
    const body = logBody(r.output);
    fs.mkdirSync(path.join(runDir, VERIFY_DIR), { recursive: true });
    atomicWrite(path.join(runDir, rel), body);
    const rec: VerifyCommandRecord = { name: c.name, exit: r.exit, ms: r.ms, timed_out: r.timedOut, log: rel, ...(r.error ? { error: r.error } : {}) };
    commands.push(rec);
    tails[c.name] = tailText(r.output, VERIFY_TAIL_BYTES).replace(/\r\n/g, "\n");
    hooks.end?.(rec);
    if (!commandPassed(rec)) return { cancelled: false, passed: false, commands, tails, failed: rec };
  }
  if (opts.signal?.aborted) return { cancelled: true };
  return { cancelled: false, passed: true, commands, tails };
}

export const commandPassed = (c: VerifyCommandRecord): boolean => c.exit === 0 && !c.timed_out && !c.error;

/** How a failed command reads: "exit 1", "timed out after 600s", ... */
export function describeFailure(c: VerifyCommandRecord, timeoutSec?: number): string {
  if (c.error) return `could not be run (${c.error})`;
  if (c.timed_out) return `timed out${timeoutSec ? ` after ${timeoutSec}s` : ""} and was killed`;
  return c.exit === null ? "was killed by a signal" : `exited with code ${c.exit}`;
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** `## Dispatcher verification`: appended by the dispatcher after the lead's own report. */
export function verificationSection(rec: VerifyRecord, verify: VerifySettings, cwd: string): string {
  const lines = rec.commands.map((c) => `- \`${c.name}\`: ${commandPassed(c) ? "passed" : `FAILED, ${describeFailure(c, verify.commands.find((x) => x.name === c.name)?.timeout_sec)}`} (${secs(c.ms)}, log ${c.log})`);
  const skipped = verify.commands.slice(rec.commands.length).map((c) => `- \`${c.name}\`: not run (an earlier command failed)`);
  return `## Dispatcher verification\n\nRun by the dispatcher in ${cwd}, not by an agent: ${rec.passed ? "all commands passed" : "NOT all commands passed"}.\n\n${[...lines, ...skipped].join("\n")}\n`;
}

/** The mail that sends a failed `done` back to the lead. */
export function rejectionMessage(failed: VerifyCommandRecord, run: string, tail: string, timeoutSec: number, count: number, max: number): string {
  return `The run was not ended: before accepting your \`done\` (outcome completed) the dispatcher ran the project's verify commands, and one failed.\n\nCommand \`${failed.name}\` (\`${run}\`) ${describeFailure(failed, timeoutSec)}. Later commands were not run.\n\nLast output (at most ${VERIFY_TAIL_BYTES} bytes; the full log is ${failed.log} in the run directory):\n\n\`\`\`\n${tail.trimEnd()}\n\`\`\`\n\nFix the cause, then send \`done\` again. If the work cannot pass, report \`partial\` or \`blocked\` honestly (those are not verified). (Verification rejection ${count} of ${max}.)`;
}

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "./fs-util.js";

/** The project-wide lock of older versions. Still read (it counts as one active run) and cleared; never written. */
export const LOCK_FILE = "lock.json";
/** One lock file per active run: `<project home>/locks/<run-id>.json`. */
export const LOCKS_DIR = "locks";
const ADMIT_FILE = ".admit";
const HEARTBEAT_MS = 5000;

export interface LockOptions {
  heartbeatMs?: number;
  /** The run works directly in the project checkout (not in its own worktree): only one such run may be active. It is written with `exclusive` too, so older binaries keep out. */
  checkout?: boolean;
  /** The holder needs the whole project (e.g. a memory tidy): refused while any other lock is alive, and it keeps every other lock out while held. */
  exclusive?: boolean;
  /** For a checkout run's refusal message: the checkout directory, and why this run has no worktree. */
  dir?: string;
  reason?: string;
}

export interface LockInfo {
  token: string;
  hostname: string;
  pid: number;
  /** Start time of `pid` (see `pidStartFrom`), to tell the holder from a different process that reused the pid. */
  pid_started?: string;
  run_id: string;
  acquired_at: string;
  heartbeat_at: string;
  /** Held by an operation that needs the project to itself (a memory tidy). */
  exclusive?: boolean;
  /** `true`: works in the project checkout; `false`: in its own worktree (or holds no files, like `clear`). Absent: an older version's run, treated as a checkout run. */
  checkout?: boolean;
}

export type LockKind = "checkout" | "whole" | "worktree";

/** What a lock protects: the checkout, the whole project (tidy/restore), or nothing shared (a worktree run). Locks of older versions count as checkout runs. */
export function lockKind(l: Pick<LockInfo, "exclusive" | "checkout">): LockKind {
  if (l.exclusive && l.checkout === true) return "checkout";
  if (l.exclusive) return "whole";
  if (l.checkout === false) return "worktree";
  return "checkout";
}

export interface ProjectLease {
  readonly info: LockInfo;
  /** True once another process replaced our lock file; the run should stop writing. */
  readonly lost: boolean;
  release(): void;
}

/** Field 22 (starttime, in clock ticks) of a /proc/<pid>/stat line. The command name (field 2) may contain spaces and ")". */
export function parseProcStat(text: string): string | undefined {
  const end = text.lastIndexOf(")");
  if (end < 0) return undefined;
  const fields = text.slice(end + 2).split(" "); // fields[0] is field 3 (state), so field 22 is fields[19]
  const v = fields[19];
  return v && /^\d+$/.test(v) ? v : undefined;
}

export interface PidStartIo {
  platform: NodeJS.Platform;
  readFile(p: string): string | undefined;
  ps(pid: number): string | undefined;
}

/** A start time that identifies one process: `proc:<ticks>` on Linux, the `ps` text elsewhere or when /proc cannot be read. */
export function pidStartFrom(pid: number, io: PidStartIo): string | undefined {
  if (io.platform === "linux") {
    const text = io.readFile(`/proc/${pid}/stat`);
    const ticks = text ? parseProcStat(text) : undefined;
    if (ticks) return `proc:${ticks}`;
  }
  return io.ps(pid);
}

const psLstart = (pid: number, env: NodeJS.ProcessEnv): string | undefined => {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env });
  return (r.status === 0 ? r.stdout.trim() : "") || undefined;
};

/** Reader side: C locale, so `ps` start times stay in one language and `samePidStart` can compare them. */
export const readerPs = (pid: number): string | undefined => psLstart(pid, { ...process.env, LANG: "C", LC_ALL: "C" });

/** Writer side: the inherited environment, exactly what versions before 0.29.0 wrote and compare against raw; never pin it, or an older reader in a non-C locale judges the lock dead and takes the run over. */
export const writerPs = (pid: number): string | undefined => psLstart(pid, process.env);

const fileReader = (p: string): string | undefined => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

const realIo: PidStartIo = { platform: process.platform, readFile: fileReader, ps: readerPs };
const writerIo: PidStartIo = { ...realIo, ps: writerPs };

function pidStart(pid: number): string | undefined {
  return pidStartFrom(pid, writerIo);
}

const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

/** `ps -o lstart` in the C locale, or the same instant from a Chinese macOS locale, as `YYYY-MM-DDTHH:mm:ss`. */
function canonicalLstart(text: string): string | undefined {
  const s = text.trim();
  const en = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(s);
  if (en) {
    const month = MONTHS[en[1] ?? ""];
    if (!month) return undefined;
    return `${en[6]}-${month}-${(en[2] ?? "").padStart(2, "0")}T${en[3]}:${en[4]}:${en[5]}`;
  }
  const zh = /^\S+\s+(\d{1,2})月\/\s*(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(s);
  if (zh) return `${zh[6]}-${(zh[1] ?? "").padStart(2, "0")}-${(zh[2] ?? "").padStart(2, "0")}T${zh[3]}:${zh[4]}:${zh[5]}`;
  return undefined;
}

/** True when both strings name the same process start. Locale-specific `ps` text for one instant matches. */
export function samePidStart(a: string, b: string): boolean {
  if (a === b) return true;
  const left = canonicalLstart(a);
  const right = canonicalLstart(b);
  return !!left && left === right;
}

export interface LivenessIo extends PidStartIo {
  signal0(pid: number): boolean;
  psUtc(pid: number): string | undefined;
}

export const utcPsEnv = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...base, LANG: "C", LC_ALL: "C", TZ: "UTC0" });

export const readerPsUtc = (pid: number): string | undefined => psLstart(pid, utcPsEnv(process.env));

/** Only ESRCH proves absence; permissions and unknown signal errors are conservative. */
export function signalAlive(pid: number, kill: (pid: number, signal: 0) => unknown = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
}

const realLivenessIo: LivenessIo = {
  ...realIo,
  signal0: signalAlive,
  psUtc: readerPsUtc,
};

function lstartFieldsMs(text: string): number | undefined {
  const c = canonicalLstart(text);
  const ms = c === undefined ? NaN : Date.parse(`${c}Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === c ? ms : undefined;
}

/** Conventional quarter-hour offsets only; arbitrary POSIX TZ offsets remain a limitation. */
export function sameStartAnyZone(written: string, utc: string): boolean | undefined {
  const a = lstartFieldsMs(written);
  const b = lstartFieldsMs(utc);
  if (a === undefined || b === undefined) return undefined;
  const d = (a - b) / 1000;
  return Number.isInteger(d) && d % 900 === 0 && Math.abs(d) <= 26 * 3600;
}

/**
 * Is the process that wrote this lock still the same running process? Judged by pid and its start time,
 * never by hostname (macOS changes it with the network) or by heartbeat age (a busy holder may be late).
 */
export function lockHolderAlive(info: Pick<LockInfo, "pid" | "pid_started">, io: LivenessIo = realLivenessIo): boolean {
  if (!io.signal0(info.pid)) return false;
  const written = info.pid_started;
  if (typeof written !== "string" || !written) return true;
  if (io.platform === "linux") {
    if (!written.startsWith("proc:")) return true;
    const ticks = parseProcStat(io.readFile(`/proc/${info.pid}/stat`) ?? "");
    return !ticks || `proc:${ticks}` === written;
  }
  if (written.startsWith("proc:")) return true;
  const local = io.ps(info.pid);
  if (!local || samePidStart(written, local)) return true;
  const utc = io.psUtc(info.pid);
  if (!utc) return true;
  return sameStartAnyZone(written, utc) !== false;
}

type Read = { kind: "none" } | { kind: "unreadable" } | { kind: "ok"; info: LockInfo };

function readLockFile(file: string): Read {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { kind: "none" };
  }
  try {
    const j = JSON.parse(text);
    if (j && typeof j.token === "string" && typeof j.pid === "number" && typeof j.run_id === "string") return { kind: "ok", info: j as LockInfo };
  } catch {
    /* fall through */
  }
  return { kind: "unreadable" };
}

const runLockFile = (root: string, runId: string) => path.join(root, LOCKS_DIR, `${runId}.json`);
const legacyFile = (root: string) => path.join(root, LOCK_FILE);

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(runId)) throw new Error(`Invalid run id "${runId}" for a lock: use letters, digits, ".", "-" or "_".`);
}

/** Per-run lock files (not temp or mutex files), then the old project-wide one if it exists. */
function lockFiles(root: string): string[] {
  const dir = path.join(root, LOCKS_DIR);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    /* no locks yet */
  }
  const files = names.sort().map((n) => path.join(dir, n));
  if (fs.existsSync(legacyFile(root))) files.push(legacyFile(root));
  return files;
}

/** Every lock of a project that can be read: one per run, plus an older version's `lock.json`. Oldest first. */
export function listRunLocks(root: string): LockInfo[] {
  const out: LockInfo[] = [];
  for (const f of lockFiles(root)) {
    const r = readLockFile(f);
    if (r.kind === "ok") out.push(r.info);
  }
  return out.sort((a, b) => a.acquired_at.localeCompare(b.acquired_at) || a.run_id.localeCompare(b.run_id));
}

/** Run ids whose per-run lock file exists but cannot be read (it can only be removed with `forceUnlock(root, runId)`). */
export function listUnreadableRunLocks(root: string): string[] {
  return lockFiles(root)
    .filter((f) => path.dirname(f) !== root && readLockFile(f).kind === "unreadable")
    .map((f) => path.basename(f, ".json"));
}

/** The lock a run holds (per-run file, or an older version's `lock.json` written for that run), if readable. */
export function inspectRunLock(root: string, runId: string): LockInfo | undefined {
  const own = readLockFile(runLockFile(root, runId));
  if (own.kind === "ok") return own.info;
  const old = readLockFile(legacyFile(root));
  return old.kind === "ok" && old.info.run_id === runId ? old.info : undefined;
}

function heldError(info: LockInfo): Error {
  const late = Math.round((Date.now() - Date.parse(info.heartbeat_at)) / 1000);
  return new Error(
    `Run ${info.run_id} is still running (pid ${info.pid}, heartbeat ${Number.isFinite(late) ? late : "?"}s ago). ` +
      `A run cannot be started or resumed twice; wait for it to end, or stop it first.`,
  );
}

function checkoutBusyError(holder: LockInfo, dir: string, reason: string): Error {
  return new Error(
    `Run ${holder.run_id} (pid ${holder.pid}) is working directly in ${dir}, and this run would too (${reason}), so only one can be active. ` +
      `Wait for it to end or stop it; in a git repo with a commit, runs work in their own worktrees and can run side by side.`,
  );
}

function exclusiveError(holder: LockInfo): Error {
  return new Error(`${holder.run_id} (pid ${holder.pid}) needs the project to itself (a memory tidy or restore); wait for it to finish, then try again.`);
}

function needsIdleError(active: LockInfo[]): Error {
  return new Error(`This needs the project to itself, but ${active.map((l) => `${l.run_id} (pid ${l.pid})`).join(", ")} ${active.length === 1 ? "is" : "are"} active. Wait for ${active.length === 1 ? "it" : "them"} to end, or stop ${active.length === 1 ? "it" : "them"}.`);
}

function unreadableError(file: string): Error {
  const perRun = path.basename(path.dirname(file)) === LOCKS_DIR;
  const cmd = perRun ? `agent-lyceum clear --lock ${path.basename(file, ".json")} --force` : "agent-lyceum clear --lock --force";
  return new Error(`The run lock ${file} cannot be read or has no known owner. Check that no run is active, then run \`${cmd}\`.`);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Counting the active runs and creating our lock must happen as one step, or two starts could both pass the count.
 * A short-lived mutex file serialises them; a holder that died leaves it behind for at most 10 s.
 */
function withAdmission<T>(root: string, fn: () => T): T {
  const mutex = path.join(root, LOCKS_DIR, ADMIT_FILE);
  const deadline = Date.now() + 5000;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(mutex, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (fd !== undefined) {
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        fs.rmSync(mutex, { force: true });
      }
    }
    try {
      if (Date.now() - fs.statSync(mutex).mtimeMs > 10_000) fs.rmSync(mutex, { force: true });
    } catch {
      /* released meanwhile */
    }
    if (Date.now() > deadline) throw new Error(`Could not take the project's admission lock ${mutex}; another process holds it. Try again.`);
    sleepSync(20);
  }
}

/** Create the lock file only if absent: write a private temp file, then hard-link it into place (atomic, never half-written). */
function tryCreate(file: string, info: LockInfo): boolean {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${info.token}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function acquireProjectLock(root: string, runId: string, opts: LockOptions = {}): ProjectLease {
  assertRunId(runId);
  fs.mkdirSync(path.join(root, LOCKS_DIR), { recursive: true });
  const file = runLockFile(root, runId);
  const now = new Date().toISOString();
  const info: LockInfo = {
    token: crypto.randomBytes(16).toString("hex"),
    hostname: os.hostname(),
    pid: process.pid,
    pid_started: pidStart(process.pid),
    run_id: runId,
    acquired_at: now,
    heartbeat_at: now,
    ...(opts.exclusive || opts.checkout ? { exclusive: true } : {}),
    checkout: opts.checkout === true,
  };
  const kind = lockKind(info);

  withAdmission(root, () => {
    // 1. This run's own lock: a live holder means it is already running; a dead one is replaced.
    const own = readLockFile(file);
    if (own.kind === "unreadable") throw unreadableError(file);
    if (own.kind === "ok") {
      if (lockHolderAlive(own.info)) throw heldError(own.info);
      fs.rmSync(file, { force: true });
    }
    // 2. An older version's project-wide lock counts as one active run; a dead one is cleared.
    const old = readLockFile(legacyFile(root));
    if (old.kind === "unreadable") throw unreadableError(legacyFile(root));
    if (old.kind === "ok" && old.info.run_id === runId && lockHolderAlive(old.info)) throw heldError(old.info);
    if (old.kind === "ok" && !lockHolderAlive(old.info)) fs.rmSync(legacyFile(root), { force: true });
    // 3. The other runs that are active now.
    const active = listRunLocks(root).filter((l) => l.run_id !== runId && lockHolderAlive(l));
    const whole = active.find((l) => lockKind(l) === "whole");
    if (whole) throw exclusiveError(whole);
    if (kind === "whole" && active.length) throw needsIdleError(active);
    const busy = kind === "checkout" ? active.find((l) => lockKind(l) === "checkout") : undefined;
    if (busy) throw checkoutBusyError(busy, opts.dir ?? root, opts.reason ?? "no worktree is available for it");
    if (!tryCreate(file, info)) throw new Error(`Could not take the run lock ${file}; another process just took it. Try again.`);
  });

  let released = false;
  let lost = false;
  const mine = () => {
    const r = readLockFile(file);
    return r.kind === "ok" && r.info.token === info.token;
  };
  const timer = setInterval(() => {
    if (released) return;
    if (!mine()) {
      lost = true;
      clearInterval(timer);
      return;
    }
    info.heartbeat_at = new Date().toISOString();
    try {
      atomicWrite(file, JSON.stringify(info, null, 2));
    } catch {
      /* try again next tick */
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref();

  const release = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    process.off("exit", release);
    if (mine()) fs.rmSync(file, { force: true });
  };
  process.on("exit", release);

  return {
    info,
    get lost() {
      return lost;
    },
    release,
  };
}

/**
 * Remove a lock regardless of owner (the `clear --lock --force` escape hatch). With a run id: that run's lock (and an
 * older version's `lock.json` when it was written for that run). Without: only the older project-wide `lock.json`.
 * Returns what was there, if readable.
 */
export function forceUnlock(root: string, runId?: string): LockInfo | undefined {
  if (runId === undefined) {
    const old = readLockFile(legacyFile(root));
    fs.rmSync(legacyFile(root), { force: true });
    fs.rmSync(`${legacyFile(root)}.reclaim`, { force: true });
    return old.kind === "ok" ? old.info : undefined;
  }
  assertRunId(runId);
  const info = inspectRunLock(root, runId);
  fs.rmSync(runLockFile(root, runId), { force: true });
  const old = readLockFile(legacyFile(root));
  if (old.kind === "ok" && old.info.run_id === runId) fs.rmSync(legacyFile(root), { force: true });
  return info;
}

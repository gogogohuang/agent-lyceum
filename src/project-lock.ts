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
  /** Most runs that may hold a lock of this project at once, this one included. Default 1. */
  maxConcurrent?: number;
  /** The holder needs the whole project (e.g. a memory tidy): refused while any other lock is alive, and it keeps every other lock out while held. */
  exclusive?: boolean;
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

const realIo: PidStartIo = {
  platform: process.platform,
  readFile: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  },
  ps: (pid) => {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    const out = r.status === 0 ? r.stdout.trim() : "";
    return out || undefined;
  },
};

function pidStart(pid: number): string | undefined {
  return pidStartFrom(pid, realIo);
}

/** Two start times can only be compared when they were taken the same way. */
const sameKind = (a: string, b: string) => a.startsWith("proc:") === b.startsWith("proc:");

/**
 * Is the process that wrote this lock still the same running process? Judged by pid and its start time,
 * never by hostname (macOS changes it with the network) or by heartbeat age (a busy holder may be late).
 */
export function lockHolderAlive(info: LockInfo): boolean {
  try {
    process.kill(info.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (info.pid_started) {
    const now = pidStart(info.pid);
    if (now && sameKind(now, info.pid_started) && now !== info.pid_started) return false;
  }
  return true;
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

function limitError(active: LockInfo[], max: number): Error {
  const list = active.map((l) => `${l.run_id} (pid ${l.pid})`).join(", ");
  return new Error(
    `This project already has ${active.length} run(s) active: ${list}. At most ${max} may run at once (dispatcher.max_concurrent_runs: ${max}); ` +
      `wait for one to end, stop one, or raise max_concurrent_runs in project.yaml.`,
  );
}

function exclusiveError(holder: LockInfo): Error {
  return new Error(`${holder.run_id} (pid ${holder.pid}) needs the project to itself (a memory tidy or restore); wait for it to finish, then try again.`);
}

function needsIdleError(active: LockInfo[]): Error {
  return new Error(`This needs the project to itself, but ${active.map((l) => `${l.run_id} (pid ${l.pid})`).join(", ")} ${active.length === 1 ? "is" : "are"} active. Wait for ${active.length === 1 ? "it" : "them"} to end, or stop ${active.length === 1 ? "it" : "them"}.`);
}

function unreadableError(file: string): Error {
  return new Error(`The run lock ${file} cannot be read or has no known owner. Check that no run is active, then run \`agent-lyceum clear --lock --force\`.`);
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
  const max = opts.maxConcurrent ?? 1;
  const now = new Date().toISOString();
  const info: LockInfo = {
    token: crypto.randomBytes(16).toString("hex"),
    hostname: os.hostname(),
    pid: process.pid,
    pid_started: pidStart(process.pid),
    run_id: runId,
    acquired_at: now,
    heartbeat_at: now,
    ...(opts.exclusive ? { exclusive: true } : {}),
  };

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
    const exclusiveHolder = active.find((l) => l.exclusive);
    if (exclusiveHolder) throw exclusiveError(exclusiveHolder);
    if (opts.exclusive && active.length) throw needsIdleError(active);
    if (active.length >= max) throw limitError(active, max);
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

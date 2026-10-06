import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "./mailbox.js";

export const LOCK_FILE = "lock.json";
const RECLAIM_FILE = "lock.json.reclaim";
const HEARTBEAT_MS = 5000;

export interface LockInfo {
  token: string;
  hostname: string;
  pid: number;
  /** `ps` start time of `pid`, to tell the holder from a different process that reused the pid. */
  pid_started?: string;
  run_id: string;
  acquired_at: string;
  heartbeat_at: string;
}

export interface ProjectLease {
  readonly info: LockInfo;
  /** True once another process replaced our lock file; the run should stop writing. */
  readonly lost: boolean;
  release(): void;
}

export interface LockOptions {
  heartbeatMs?: number;
}

function pidStart(pid: number): string | undefined {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const out = r.status === 0 ? r.stdout.trim() : "";
  return out || undefined;
}

type Read = { kind: "none" } | { kind: "unreadable" } | { kind: "ok"; info: LockInfo };

function readLock(root: string): Read {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, LOCK_FILE), "utf8");
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

/** The lock of a project (`root` = the project's home directory), if one is held and readable. */
export function inspectProjectLock(root: string): LockInfo | undefined {
  const r = readLock(root);
  return r.kind === "ok" ? r.info : undefined;
}

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
    if (now && now !== info.pid_started) return false;
  }
  return true;
}

function heldError(info: LockInfo): Error {
  const late = Math.round((Date.now() - Date.parse(info.heartbeat_at)) / 1000);
  return new Error(
    `This project is still running: run ${info.run_id} (pid ${info.pid}, heartbeat ${Number.isFinite(late) ? late : "?"}s ago). ` +
      `Only one run per project at a time; wait for it to end, or stop it first.`,
  );
}

function unreadableError(root: string): Error {
  return new Error(`The project lock ${path.join(root, LOCK_FILE)} cannot be read or has no known owner. Check that no run is active, then run \`agent-team unlock --force\`.`);
}

/** Create the lock file only if absent: write a private temp file, then hard-link it into place (atomic, never half-written). */
function tryCreate(root: string, info: LockInfo): boolean {
  const tmp = path.join(root, `.${LOCK_FILE}.${info.token}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
  try {
    fs.linkSync(tmp, path.join(root, LOCK_FILE));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Replace a lock whose holder is gone. Reclaimers take a short mutex so two of them cannot delete each other's fresh lock. */
function reclaim(root: string, info: LockInfo, stale: LockInfo): boolean {
  const mutex = path.join(root, RECLAIM_FILE);
  try {
    if (Date.now() - fs.statSync(mutex).mtimeMs > 10_000) fs.rmSync(mutex, { force: true });
  } catch {
    /* no mutex yet */
  }
  let fd: number;
  try {
    fd = fs.openSync(mutex, "wx");
  } catch {
    return false;
  }
  try {
    const again = readLock(root);
    if (again.kind !== "ok" || again.info.token !== stale.token) return false;
    fs.rmSync(path.join(root, LOCK_FILE), { force: true });
    return tryCreate(root, info);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(mutex, { force: true });
  }
}

export function acquireProjectLock(root: string, runId: string, opts: LockOptions = {}): ProjectLease {
  fs.mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  const info: LockInfo = {
    token: crypto.randomBytes(16).toString("hex"),
    hostname: os.hostname(),
    pid: process.pid,
    pid_started: pidStart(process.pid),
    run_id: runId,
    acquired_at: now,
    heartbeat_at: now,
  };

  for (let attempt = 0; ; attempt++) {
    if (tryCreate(root, info)) break;
    const cur = readLock(root);
    if (cur.kind === "unreadable") throw unreadableError(root);
    if (cur.kind === "none") continue; // released between our two calls
    if (lockHolderAlive(cur.info)) throw heldError(cur.info);
    if (reclaim(root, info, cur.info)) break;
    if (attempt >= 5) throw new Error(`Could not take the project lock ${path.join(root, LOCK_FILE)}; another process is reclaiming it. Try again.`);
  }

  let released = false;
  let lost = false;
  const file = path.join(root, LOCK_FILE);
  const mine = () => {
    const r = readLock(root);
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

/** Remove the lock regardless of owner (the `unlock --force` escape hatch). Returns what was there, if readable. */
export function forceUnlock(root: string): LockInfo | undefined {
  const info = inspectProjectLock(root);
  fs.rmSync(path.join(root, LOCK_FILE), { force: true });
  fs.rmSync(path.join(root, RECLAIM_FILE), { force: true });
  return info;
}

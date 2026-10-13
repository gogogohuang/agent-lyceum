import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProjectLock, forceUnlock, inspectRunLock, listRunLocks, lockHolderAlive, LOCK_FILE, LOCKS_DIR, parseProcStat, pidStartFrom, type LockInfo, type PidStartIo } from "../src/project-lock.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const holder = path.join(here, "fixtures", "lock-holder.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "project-lock-"));
  dirs.push(d);
  return d;
};
const runLockFile = (root: string, runId: string) => path.join(root, LOCKS_DIR, `${runId}.json`);
const deadPid = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString());
const writeLock = (file: string, over: Partial<LockInfo> & { run_id: string }) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ token: `t-${over.run_id}`, hostname: os.hostname(), pid: process.pid, acquired_at: now, heartbeat_at: now, ...over }));
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Start a child that takes the lock and holds it for `holdMs`; resolves with its first output line. */
function startHolder(root: string, runId: string, holdMs: number, max = 1) {
  const child = spawn(tsx, [holder, root, runId, String(holdMs), String(max)], { stdio: ["ignore", "pipe", "pipe"] });
  const first = new Promise<string>((resolve) => {
    let buf = "";
    child.stdout.on("data", (b) => {
      buf += b;
      if (buf.includes("\n")) resolve(buf.split("\n")[0]);
    });
    child.on("exit", () => resolve(buf.split("\n")[0] || "EXIT"));
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
  return { child, first, exited };
}

describe("run locks", () => {
  it("lets exactly one of two processes start when only one run may be active", async () => {
    const root = tmp();
    const a = startHolder(root, "run-a", 1500);
    const b = startHolder(root, "run-b", 1500);
    const results = (await Promise.all([a.first, b.first])).sort();
    expect(results[0]).toBe("ACQUIRED");
    expect(results[1]).toMatch(/^DENIED .*run-(a|b)/);
    await Promise.all([a.exited, b.exited]);
    expect(listRunLocks(root)).toEqual([]);
  }, 20_000);

  it("lets two processes run at the same time when two runs may be active, and never a third", async () => {
    const root = tmp();
    const a = startHolder(root, "run-a", 2000, 2);
    const b = startHolder(root, "run-b", 2000, 2);
    const c = startHolder(root, "run-c", 2000, 2);
    const results = (await Promise.all([a.first, b.first, c.first])).sort();
    expect(results.filter((r) => r === "ACQUIRED")).toHaveLength(2);
    expect(results.filter((r) => r.startsWith("DENIED"))).toHaveLength(1);
    await Promise.all([a.exited, b.exited, c.exited]);
    expect(listRunLocks(root)).toEqual([]);
  }, 30_000);

  it("lets different projects run at the same time", () => {
    const r1 = tmp();
    const r2 = tmp();
    const l1 = acquireProjectLock(r1, "x");
    const l2 = acquireProjectLock(r2, "y");
    expect(inspectRunLock(r1, "x")?.run_id).toBe("x");
    expect(inspectRunLock(r2, "y")?.run_id).toBe("y");
    l1.release();
    l2.release();
  });

  it("lets two different runs hold a lock when the limit is 2, and refuses a third naming the runs in the way", () => {
    const root = tmp();
    const a = acquireProjectLock(root, "run-a", { maxConcurrent: 2 });
    const b = acquireProjectLock(root, "run-b", { maxConcurrent: 2 });
    expect(listRunLocks(root).map((l) => l.run_id).sort()).toEqual(["run-a", "run-b"]);
    expect(() => acquireProjectLock(root, "run-c", { maxConcurrent: 2 })).toThrow(/run-a.*run-b.*max_concurrent_runs/s);
    expect(fs.existsSync(runLockFile(root, "run-c"))).toBe(false);
    a.release();
    acquireProjectLock(root, "run-c", { maxConcurrent: 2 }).release();
    b.release();
  });

  it("refuses the same run twice, however high the limit, and names the holder", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "run-1", { maxConcurrent: 5 });
    expect(() => acquireProjectLock(root, "run-1", { maxConcurrent: 5 })).toThrow(/run-1.*still running/s);
    l.release();
  });

  it("allows only one run by default and names the one in the way", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "run-1");
    expect(() => acquireProjectLock(root, "run-2")).toThrow(/run-1/);
    l.release();
    acquireProjectLock(root, "run-2").release();
  });

  it("does not count locks whose process is gone", () => {
    const root = tmp();
    writeLock(runLockFile(root, "dead"), { run_id: "dead", pid: deadPid() });
    expect(lockHolderAlive(inspectRunLock(root, "dead")!)).toBe(false);
    acquireProjectLock(root, "new").release();
  });

  it("counts an older version's project-wide lock.json held by a live process", () => {
    const root = tmp();
    writeLock(path.join(root, LOCK_FILE), { run_id: "old-run" });
    expect(inspectRunLock(root, "old-run")?.run_id).toBe("old-run");
    expect(() => acquireProjectLock(root, "new")).toThrow(/old-run/);
    const l = acquireProjectLock(root, "new", { maxConcurrent: 2 });
    expect(listRunLocks(root).map((x) => x.run_id).sort()).toEqual(["new", "old-run"]);
    l.release();
  });

  it("replaces an older version's lock.json whose process is gone", () => {
    const root = tmp();
    writeLock(path.join(root, LOCK_FILE), { run_id: "old-run", pid: deadPid(), hostname: "other-host.local" });
    acquireProjectLock(root, "run-new").release();
    expect(fs.existsSync(path.join(root, LOCK_FILE))).toBe(false);
  });

  it("release never deletes a lock that belongs to another token", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "run-1");
    const file = runLockFile(root, "run-1");
    const other = { ...JSON.parse(fs.readFileSync(file, "utf8")), token: "someone-else" };
    fs.writeFileSync(file, JSON.stringify(other));
    l.release();
    expect(fs.existsSync(file)).toBe(true);
    expect(inspectRunLock(root, "run-1")?.token).toBe("someone-else");
  });

  it("does not take over a live holder just because its heartbeat is late", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "run-1");
    const file = runLockFile(root, "run-1");
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    info.heartbeat_at = new Date(Date.now() - 3600_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(info));
    expect(() => acquireProjectLock(root, "run-1")).toThrow(/still running|heartbeat/);
    l.release();
  });

  it("reclaims a run's lock whose process is gone, even if the hostname changed since", () => {
    const root = tmp();
    writeLock(runLockFile(root, "run-x"), { run_id: "run-x", pid: deadPid(), hostname: "other-host.local" });
    const l = acquireProjectLock(root, "run-x");
    expect(inspectRunLock(root, "run-x")?.pid).toBe(process.pid);
    l.release();
  });

  it("treats a reused pid (different start time) as a dead holder", () => {
    // the start time is in the format this platform writes: `proc:<ticks>` on Linux, `ps` text elsewhere
    const root = tmp();
    writeLock(runLockFile(root, "old"), { run_id: "old", pid_started: process.platform === "linux" ? "proc:1" : "Thu Jan  1 00:00:00 1970" });
    expect(lockHolderAlive(inspectRunLock(root, "old")!)).toBe(false);
    acquireProjectLock(root, "new").release();
  });

  it("asks for a manual unlock when the old lock file cannot be understood, and force-unlock clears it", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, LOCK_FILE), "garbage");
    expect(() => acquireProjectLock(root, "r")).toThrow(/clear --lock/);
    expect(forceUnlock(root)?.token).toBeUndefined();
    expect(fs.existsSync(path.join(root, LOCK_FILE))).toBe(false);
    acquireProjectLock(root, "r").release();
  });

  it("force-unlock by run id removes only that run's lock", () => {
    const root = tmp();
    const a = acquireProjectLock(root, "run-a", { maxConcurrent: 2 });
    const b = acquireProjectLock(root, "run-b", { maxConcurrent: 2 });
    expect(forceUnlock(root, "run-a")?.run_id).toBe("run-a");
    expect(listRunLocks(root).map((l) => l.run_id)).toEqual(["run-b"]);
    a.release();
    b.release();
  });

  it("keeps the heartbeat fresh while held", async () => {
    const root = tmp();
    const l = acquireProjectLock(root, "r", { heartbeatMs: 30 });
    const t0 = inspectRunLock(root, "r")!.heartbeat_at;
    await new Promise((r) => setTimeout(r, 150));
    expect(inspectRunLock(root, "r")!.heartbeat_at > t0).toBe(true);
    l.release();
  });

  it("an exclusive lock needs the project to be idle, and keeps every other lock out while held", () => {
    const root = tmp();
    const run = acquireProjectLock(root, "run-a", { maxConcurrent: 3 });
    expect(() => acquireProjectLock(root, "tidy-1", { maxConcurrent: 3, exclusive: true })).toThrow(/run-a/);
    run.release();
    const tidy = acquireProjectLock(root, "tidy-1", { maxConcurrent: 3, exclusive: true });
    expect(inspectRunLock(root, "tidy-1")?.exclusive).toBe(true);
    expect(() => acquireProjectLock(root, "run-b", { maxConcurrent: 3 })).toThrow(/tidy-1/);
    tidy.release();
    acquireProjectLock(root, "run-b", { maxConcurrent: 3 }).release();
  });

  it("an exclusive lock whose process is gone does not block anyone", () => {
    const root = tmp();
    writeLock(runLockFile(root, "tidy-dead"), { run_id: "tidy-dead", pid: deadPid(), exclusive: true });
    acquireProjectLock(root, "run-a", { maxConcurrent: 2 }).release();
  });

  it("rejects a run id that is not a plain name", () => {
    const root = tmp();
    expect(() => acquireProjectLock(root, "../escape")).toThrow(/run id/i);
  });
});

describe("pid start time", () => {
  // comm is field 2 and may hold spaces and parentheses; starttime is field 22
  const stat = (start: string) => `4242 (my (odd) proc) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${start} 1000 100 18446744073709551615`;

  it("reads starttime from /proc stat even when the command name has spaces and parentheses", () => {
    expect(parseProcStat(stat("987654"))).toBe("987654");
  });

  it("returns undefined for text that is not a stat line", () => {
    expect(parseProcStat("garbage")).toBeUndefined();
    expect(parseProcStat("1 (x) S 1")).toBeUndefined();
  });

  it("uses /proc on linux and falls back to ps when it cannot be read", () => {
    const io = (readFile: PidStartIo["readFile"]): PidStartIo => ({ platform: "linux", readFile, ps: () => "Tue Oct  7 11:00:00 2026" });
    expect(pidStartFrom(4242, io(() => stat("55")))).toBe("proc:55");
    expect(pidStartFrom(4242, io(() => undefined))).toBe("Tue Oct  7 11:00:00 2026");
  });

  it("uses ps on other platforms", () => {
    expect(pidStartFrom(1, { platform: "darwin", readFile: () => stat("55"), ps: () => "Tue Oct  7 11:00:00 2026" })).toBe("Tue Oct  7 11:00:00 2026");
  });

  it("does not call a live holder dead when the lock was written in the other start-time format", () => {
    const other = process.platform === "linux" ? "Tue Oct  7 11:00:00 2026" : "proc:1";
    const info: LockInfo = { token: "t", hostname: "h", pid: process.pid, pid_started: other, run_id: "r", acquired_at: "", heartbeat_at: "" };
    expect(lockHolderAlive(info)).toBe(true);
  });

  it("calls a holder dead when the same-format start time differs (pid reused)", () => {
    const read = (p: string) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    };
    const ps = (pid: number) => {
      const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
      return r.status === 0 ? r.stdout.trim() || undefined : undefined;
    };
    const now = pidStartFrom(process.pid, { platform: process.platform, readFile: read, ps });
    if (!now) return; // no way to read a start time on this machine
    const wrong = now.startsWith("proc:") ? "proc:1" : "Mon Jan  1 00:00:00 2001";
    const info: LockInfo = { token: "t", hostname: "h", pid: process.pid, pid_started: wrong, run_id: "r", acquired_at: "", heartbeat_at: "" };
    expect(lockHolderAlive(info)).toBe(false);
  });
});

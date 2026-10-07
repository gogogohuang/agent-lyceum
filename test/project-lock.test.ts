import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProjectLock, forceUnlock, inspectProjectLock, lockHolderAlive, LOCK_FILE, parseProcStat, pidStartFrom, type LockInfo, type PidStartIo } from "../src/project-lock.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const holder = path.join(here, "fixtures", "lock-holder.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "project-lock-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Start a child that takes the lock and holds it for `holdMs`; resolves with its first output line. */
function startHolder(root: string, runId: string, holdMs: number) {
  const child = spawn(tsx, [holder, root, runId, String(holdMs)], { stdio: ["ignore", "pipe", "pipe"] });
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

describe("project lock", () => {
  it("lets exactly one of two processes start on the same project", async () => {
    const root = tmp();
    const a = startHolder(root, "run-a", 1500);
    const b = startHolder(root, "run-b", 1500);
    const results = (await Promise.all([a.first, b.first])).sort();
    expect(results[0]).toBe("ACQUIRED");
    expect(results[1]).toMatch(/^DENIED .*run-(a|b)/);
    await Promise.all([a.exited, b.exited]);
    expect(inspectProjectLock(root)).toBeUndefined();
  }, 20_000);

  it("lets different projects run at the same time", () => {
    const r1 = tmp();
    const r2 = tmp();
    const l1 = acquireProjectLock(r1, "x");
    const l2 = acquireProjectLock(r2, "y");
    expect(inspectProjectLock(r1)?.run_id).toBe("x");
    expect(inspectProjectLock(r2)?.run_id).toBe("y");
    l1.release();
    l2.release();
  });

  it("refuses a second acquire in the same process and names the holder", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "run-1");
    expect(() => acquireProjectLock(root, "run-2")).toThrow(/run-1/);
    l.release();
    acquireProjectLock(root, "run-2").release();
  });

  it("release never deletes a lock that belongs to another token", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "run-1");
    const file = path.join(root, LOCK_FILE);
    const other = { ...JSON.parse(fs.readFileSync(file, "utf8")), token: "someone-else" };
    fs.writeFileSync(file, JSON.stringify(other));
    l.release();
    expect(fs.existsSync(file)).toBe(true);
    expect(inspectProjectLock(root)?.token).toBe("someone-else");
  });

  it("does not take over a live holder just because its heartbeat is late", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "run-1");
    const file = path.join(root, LOCK_FILE);
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    info.heartbeat_at = new Date(Date.now() - 3600_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(info));
    expect(() => acquireProjectLock(root, "run-2")).toThrow(/still running|heartbeat/);
    l.release();
  });

  it("reclaims a lock whose process is gone, even if the hostname changed since", () => {
    const root = tmp();
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    const pid = Number(dead.stdout.toString());
    fs.writeFileSync(
      path.join(root, LOCK_FILE),
      JSON.stringify({ token: "old", hostname: "other-host.local", pid, run_id: "old-run", heartbeat_at: new Date().toISOString(), acquired_at: new Date().toISOString() }),
    );
    expect(lockHolderAlive(inspectProjectLock(root)!)).toBe(false);
    const l = acquireProjectLock(root, "run-new");
    expect(inspectProjectLock(root)?.run_id).toBe("run-new");
    l.release();
  });

  it("treats a reused pid (different start time) as a dead holder", () => {
    // the start time is in the format this platform writes: `proc:<ticks>` on Linux, `ps` text elsewhere
    const root = tmp();
    fs.writeFileSync(
      path.join(root, LOCK_FILE),
      JSON.stringify({ token: "old", hostname: os.hostname(), pid: process.pid, pid_started: process.platform === "linux" ? "proc:1" : "Thu Jan  1 00:00:00 1970", run_id: "old", heartbeat_at: new Date().toISOString(), acquired_at: new Date().toISOString() }),
    );
    expect(lockHolderAlive(inspectProjectLock(root)!)).toBe(false);
    acquireProjectLock(root, "new").release();
  });

  it("asks for a manual unlock when the lock file cannot be understood, and force-unlock clears it", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, LOCK_FILE), "garbage");
    expect(() => acquireProjectLock(root, "r")).toThrow(/unlock/);
    expect(forceUnlock(root)?.token).toBeUndefined();
    expect(fs.existsSync(path.join(root, LOCK_FILE))).toBe(false);
    acquireProjectLock(root, "r").release();
  });

  it("keeps the heartbeat fresh while held", async () => {
    const root = tmp();
    const l = acquireProjectLock(root, "r", { heartbeatMs: 30 });
    const t0 = inspectProjectLock(root)!.heartbeat_at;
    await new Promise((r) => setTimeout(r, 150));
    expect(inspectProjectLock(root)!.heartbeat_at > t0).toBe(true);
    l.release();
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

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireProjectLock as acquireOld, lockHolderAlive as oldLockHolderAlive } from "./fixtures/lock-v0.17.3.js";
import { acquireProjectLock, forceUnlock, inspectRunLock, listRunLocks, listUnreadableRunLocks, lockHolderAlive, LOCK_FILE, lockKind, LOCKS_DIR, parseProcStat, pidStartFrom, readerPs, readerPsUtc, samePidStart, writerPs, type LivenessIo, sameStartAnyZone, signalAlive, utcPsEnv, type LockInfo, type PidStartIo } from "../src/project-lock.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const holder = path.join(here, "fixtures", "lock-holder.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");

const realPs = (pid: number, zone?: string) => {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C", ...(zone === undefined ? {} : { TZ: zone }) } });
  return r.status === 0 ? r.stdout.trim() : "";
};
const inheritedPs = (pid: number) => {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
};
const psAvailable = !!realPs(process.pid, "UTC0");

const holderAvailable = spawnSync(tsx, ["--eval", ""], { encoding: "utf8" }).status === 0;

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
function startHolder(root: string, runId: string, holdMs: number, kind = "checkout") {
  const child = spawn(tsx, [holder, root, runId, String(holdMs), kind], { stdio: ["ignore", "pipe", "pipe"] });
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
  it.skipIf(!holderAvailable)("lets exactly one of two processes start when both need the checkout", async () => {
    const root = tmp();
    const a = startHolder(root, "run-a", 1500);
    const b = startHolder(root, "run-b", 1500);
    const results = (await Promise.all([a.first, b.first])).sort();
    expect(results[0]).toBe("ACQUIRED");
    expect(results[1]).toMatch(/^DENIED .*run-(a|b)/);
    await Promise.all([a.exited, b.exited]);
    expect(listRunLocks(root)).toEqual([]);
  }, 20_000);

  it.skipIf(!holderAvailable)("lets any number of worktree processes run at the same time", async () => {
    const root = tmp();
    const a = startHolder(root, "run-a", 2000, "worktree");
    const b = startHolder(root, "run-b", 2000, "worktree");
    const c = startHolder(root, "run-c", 2000, "worktree");
    const results = (await Promise.all([a.first, b.first, c.first])).sort();
    expect(results.filter((r) => r === "ACQUIRED")).toHaveLength(3);
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

  it("refuses the same run twice, however high the limit, and names the holder", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "run-1", { checkout: false });
    expect(() => acquireProjectLock(root, "run-1", { checkout: false })).toThrow(/run-1.*still running/s);
    l.release();
  });

  it("allows only one checkout run and names the one in the way", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "run-1", { checkout: true });
    expect(() => acquireProjectLock(root, "run-2", { checkout: true })).toThrow(/run-1/);
    l.release();
    acquireProjectLock(root, "run-2", { checkout: true }).release();
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
    expect(() => acquireProjectLock(root, "new", { checkout: true })).toThrow(/old-run/);
    const l = acquireProjectLock(root, "new", { checkout: false });
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

  it.skipIf(process.platform !== "linux" && !psAvailable)("treats a reused pid (different start time) as a dead holder", () => {
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

  it("an unreadable per-run lock names the run id in its error, and force-unlock by run id removes it", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, LOCKS_DIR), { recursive: true });
    fs.writeFileSync(runLockFile(root, "run-z"), "garbage");
    expect(() => acquireProjectLock(root, "run-z")).toThrow(/clear --lock run-z --force/);
    expect(listUnreadableRunLocks(root)).toEqual(["run-z"]);
    expect(forceUnlock(root, "run-z")).toBeUndefined();
    expect(fs.existsSync(runLockFile(root, "run-z"))).toBe(false);
    acquireProjectLock(root, "run-z").release();
  });

  it("force-unlock by run id removes only that run's lock", () => {
    const root = tmp();
    const a = acquireProjectLock(root, "run-a", { checkout: false });
    const b = acquireProjectLock(root, "run-b", { checkout: false });
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
    const run = acquireProjectLock(root, "run-a", { checkout: false });
    expect(() => acquireProjectLock(root, "tidy-1", { exclusive: true })).toThrow(/run-a/);
    run.release();
    const tidy = acquireProjectLock(root, "tidy-1", { exclusive: true });
    expect(inspectRunLock(root, "tidy-1")?.exclusive).toBe(true);
    expect(() => acquireProjectLock(root, "run-b", { checkout: false })).toThrow(/tidy-1/);
    tidy.release();
    acquireProjectLock(root, "run-b", { checkout: false }).release();
  });

  it("an exclusive lock whose process is gone does not block anyone", () => {
    const root = tmp();
    writeLock(runLockFile(root, "tidy-dead"), { run_id: "tidy-dead", pid: deadPid(), exclusive: true });
    acquireProjectLock(root, "run-a", { checkout: false }).release();
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

  it("treats a Chinese ps start time and an English one as the same instant", () => {
    expect(samePidStart("三 10月/28 12:43:17 2026", "Wed Oct 28 12:43:17 2026")).toBe(true);
    expect(samePidStart("三 10月/ 8 09:05:01 2026", "Wed Oct  8 09:05:01 2026")).toBe(true);
    expect(samePidStart("Wed Oct 28 12:43:17 2026", "Wed Oct 28 12:43:18 2026")).toBe(false);
    expect(samePidStart("proc:1", "proc:2")).toBe(false);
  });

  it("calls a holder dead when the same-format start time differs (pid reused)", (context) => {
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
    if (!now) context.skip(); // explicitly unverified when the real start time is unavailable
    const wrong = now.startsWith("proc:") ? "proc:1" : "Mon Jan  1 00:00:00 2001";
    const info: LockInfo = { token: "t", hostname: "h", pid: process.pid, pid_started: wrong, run_id: "r", acquired_at: "", heartbeat_at: "" };
    expect(lockHolderAlive(info)).toBe(false);
  });
});

describe("lock kinds", () => {
  it("a checkout lock is written with exclusive and checkout", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "c", { checkout: true });
    expect(inspectRunLock(root, "c")).toMatchObject({ exclusive: true, checkout: true });
    const w = acquireProjectLock(root, "w", { checkout: false });
    expect(inspectRunLock(root, "w")?.checkout).toBe(false);
    expect(inspectRunLock(root, "w")?.exclusive).toBeUndefined();
    expect(lockKind(l.info)).toBe("checkout");
    expect(lockKind(w.info)).toBe("worktree");
    expect(lockKind({ exclusive: true })).toBe("whole");
    expect(lockKind({})).toBe("checkout");
    l.release();
    w.release();
  });

  it("two checkout runs: the second is refused, in either order", () => {
    const root = tmp();
    const a = acquireProjectLock(root, "a", { checkout: true });
    expect(() => acquireProjectLock(root, "b", { checkout: true, dir: "/repo", reason: "not a git repository" })).toThrow(/Run a .*working directly in \/repo.*not a git repository.*only one can be active/s);
    a.release();
    const b = acquireProjectLock(root, "b", { checkout: true });
    expect(() => acquireProjectLock(root, "a", { checkout: true })).toThrow(/Run b/);
    b.release();
  });

  it("worktree runs run beside each other and beside one checkout run", () => {
    const root = tmp();
    const w1 = acquireProjectLock(root, "w1", { checkout: false });
    const w2 = acquireProjectLock(root, "w2", { checkout: false });
    const c = acquireProjectLock(root, "c", { checkout: true });
    expect(listRunLocks(root)).toHaveLength(3);
    for (const l of [w1, w2, c]) l.release();
  });

  it("a checkout run is refused by an old run lock without checkout and by lock.json", () => {
    const root = tmp();
    writeLock(runLockFile(root, "old"), { run_id: "old" });
    expect(() => acquireProjectLock(root, "c", { checkout: true })).toThrow(/Run old/);
    acquireProjectLock(root, "w", { checkout: false }).release();
    fs.rmSync(runLockFile(root, "old"));
    writeLock(path.join(root, LOCK_FILE), { run_id: "legacy" });
    expect(() => acquireProjectLock(root, "c", { checkout: true })).toThrow(/Run legacy/);
  });

  it("tidy is refused while a checkout run is active, and a checkout run is refused while tidy is active", () => {
    const root = tmp();
    const c = acquireProjectLock(root, "c", { checkout: true });
    expect(() => acquireProjectLock(root, "tidy", { exclusive: true })).toThrow(/needs the project to itself.*c \(pid/s);
    c.release();
    const t = acquireProjectLock(root, "tidy", { exclusive: true });
    expect(() => acquireProjectLock(root, "c", { checkout: true })).toThrow(/tidy.*needs the project to itself/s);
    expect(() => acquireProjectLock(root, "w", { checkout: false })).toThrow(/tidy/);
    t.release();
  });

  it("clear's lock is admitted beside a checkout run", () => {
    const root = tmp();
    const c = acquireProjectLock(root, "c", { checkout: true });
    acquireProjectLock(root, "clear-x", { checkout: false }).release();
    c.release();
  });

  it("an old binary cannot admit a second checkout run (mixed versions)", () => {
    const root = tmp();
    const a = acquireProjectLock(root, "A", { checkout: true });
    expect(() => acquireOld(root, "B", { maxConcurrent: 2 })).toThrow(/needs the project to itself/);
    expect(fs.existsSync(runLockFile(root, "B"))).toBe(false);
    a.release();
    const b = acquireOld(root, "B", { maxConcurrent: 2 });
    expect(() => acquireProjectLock(root, "A", { checkout: true })).toThrow(/Run B .*working directly/s);
    b.release();
  });

  it("an old binary still admits two legacy shared runs beside only worktree locks (known limitation)", () => {
    const root = tmp();
    const w = acquireProjectLock(root, "W", { checkout: false });
    const o1 = acquireOld(root, "O1", { maxConcurrent: 3 });
    const o2 = acquireOld(root, "O2", { maxConcurrent: 3 });
    expect(listRunLocks(root)).toHaveLength(3);
    for (const l of [w, o1, o2]) l.release();
  });
});

describe("conservative cross-zone liveness", () => {
  const utc = "Wed Oct 28 05:43:17 2026";
  function io(over: Partial<LivenessIo> = {}): LivenessIo {
    return { platform: "darwin", signal0: () => true, readFile: () => undefined, ps: () => utc, psUtc: () => utc, ...over };
  }
  const info = (pid_started?: string): Pick<LockInfo, "pid" | "pid_started"> => ({ pid: 123, pid_started });
  const text = (ms: number, zh = false): string => {
    const d = new Date(ms);
    const parts = d.toUTCString().split(" ");
    return zh ? `三 ${d.getUTCMonth() + 1}月/${d.getUTCDate()} ${parts[4]} ${parts[3]}` : `${parts[0]?.slice(0, 3)} ${parts[2]} ${parts[1]} ${parts[4]} ${parts[3]}`;
  };
  const instant = Date.parse("2026-10-28T05:43:17Z");
  it.each([420, 345, -570, 825, 840, -720])("accepts conventional offset %i in C and zh text", offset => {
    for (const zh of [false, true]) expect(lockHolderAlive(info(text(instant + offset * 60_000, zh)), io())).toBe(true);
  });
  it("does not read acquired_at, even a throwing getter", () => {
    for (const acquired_at of ["2026-10-28T03:43:17Z", "2026-10-30T05:43:17Z", ""]) {
      expect(lockHolderAlive({ ...info("Wed Oct 28 12:43:17 2026"), acquired_at } as LockInfo, io())).toBe(true);
    }
    const lock = Object.defineProperty(info("Wed Oct 28 12:43:17 2026"), "acquired_at", { get() { throw new Error("must not read"); } });
    expect(lockHolderAlive(lock, io())).toBe(true);
  });
  it("detects 37-second and 34-hour reuse but conservatively accepts exact-hour reuse", () => {
    for (const [delta, alive] of [[37_000, false], [3600_000, true], [34 * 3600_000, false]] as const) {
      const current = text(instant + delta);
      expect(lockHolderAlive(info("Wed Oct 28 12:43:17 2026"), io({ ps: () => current, psUtc: () => current }))).toBe(alive);
    }
  });
  it("accepts inclusive ±26 hours, rejects outside and handles ignored TZ", () => {
    for (const sign of [-1, 1]) {
      expect(sameStartAnyZone(text(instant + sign * 26 * 3600_000), utc)).toBe(true);
      expect(sameStartAnyZone(text(instant + sign * (26 * 3600_000 + 900_000)), utc)).toBe(false);
    }
    expect(lockHolderAlive(info(text(instant + 14 * 3600_000)), io({ ps: () => text(instant - 12 * 3600_000), psUtc: () => text(instant - 12 * 3600_000) }))).toBe(true);
  });
  it.each(["garbage", "Wed Feb 30 05:43:17 2026", "三 13月/28 05:43:17 2026", "Wed Oct 28 25:43:17 2026", "Wed Xxx 28 05:43:17 2026"])("treats invalid or unknown fields as unknown: %s", written => {
    expect(sameStartAnyZone(written, utc)).toBeUndefined();
    expect(lockHolderAlive(info(written), io())).toBe(true);
  });
  it("keeps local equality as a fast path, including odd POSIX offsets", () => {
    for (const written of [utc, "Wed Oct 28 05:44:17 2026", "三 10月/28 05:43:17 2026"]) {
      expect(lockHolderAlive(info(written), io({ ps: () => written, psUtc: () => { throw new Error("unexpected UTC read"); } }))).toBe(true);
    }
  });
  it("keeps missing, empty and non-string identities alive without ps", () => {
    for (const written of [undefined, "", 42]) {
      expect(lockHolderAlive(info(written as string), io({ ps: () => { throw new Error("unexpected ps"); } }))).toBe(true);
    }
  });
  it("fails toward alive on missing local or UTC observations", () => {
    expect(lockHolderAlive(info("different"), io({ ps: () => undefined, psUtc: () => { throw new Error("unexpected UTC read"); } }))).toBe(true);
    for (const psUtc of [undefined, "", "garbage"]) expect(lockHolderAlive(info("Wed Oct 28 12:43:17 2026"), io({ psUtc: () => psUtc }))).toBe(true);
  });
  it("supports pid-only callers and treats only ESRCH as dead", () => {
    for (const alive of [true, false]) expect(lockHolderAlive({ pid: 123 }, io({ signal0: () => alive, ps: () => { throw new Error("unexpected ps"); } }))).toBe(alive);
    for (const code of ["EPERM", "EUNKNOWN", undefined, "ESRCH"]) expect(signalAlive(123, () => { throw Object.assign(new Error("signal"), { code }); })).toBe(code !== "ESRCH");
    expect(signalAlive(123, () => { throw null; })).toBe(true);
    expect(lockHolderAlive(info(utc), io({ signal0: () => false, ps: () => { throw new Error("unexpected ps"); } }))).toBe(false);
  });
  it("preserves Linux ticks and avoids ps for Linux text and non-Linux proc identities", () => {
    const noPs = () => { throw new Error("unexpected ps"); };
    for (const [ticks, alive] of [["55", true], ["56", false], [undefined, true]] as const) {
      const stat = ticks ? `1 (process) ${[...Array(19).fill("0"), ticks].join(" ")}` : undefined;
      expect(lockHolderAlive(info("proc:55"), io({ platform: "linux", readFile: () => stat, ps: noPs, psUtc: noPs }))).toBe(alive);
    }
    expect(lockHolderAlive(info(utc), io({ platform: "linux", ps: noPs, psUtc: noPs }))).toBe(true);
    expect(lockHolderAlive(info("proc:55"), io({ ps: noPs, psUtc: noPs }))).toBe(true);
  });
  it("forces C/UTC0 without mutating the inherited environment", () => {
    const base = { TZ: "Asia/Taipei", LANG: "zh_TW.UTF-8", OTHER: "kept" };
    expect(utcPsEnv(base)).toEqual({ TZ: "UTC0", LANG: "C", LC_ALL: "C", OTHER: "kept" });
    expect(base.TZ).toBe("Asia/Taipei");
  });
  it("never adds a dead verdict over legacy text comparisons (seeded offset/reuse table)", () => {
    let seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const offsets = [...Array.from({ length: 40 }, (_, i) => -720 + i * 40).map(v => Math.round(v / 15) * 15), 197, -73, 1];
    for (let i = 0; i < 2000; i++) {
      const written = text(instant + offsets[random() % offsets.length]! * 60_000, !!(random() % 2));
      const local = text(instant + (random() % (48 * 3600)) * 1000);
      const reading = text(instant + (random() % (48 * 3600)) * 1000);
      if (!lockHolderAlive(info(written), io({ ps: () => local, psUtc: () => reading }))) expect(samePidStart(written, local)).toBe(false);
    }
  });
});


it.skipIf(!psAvailable)("real other-zone writer stays alive with a differing UTC negative control", () => {
  const written = realPs(process.pid, "Asia/Kathmandu");
  expect(written).not.toBe(realPs(process.pid, "UTC0"));
  expect(lockHolderAlive({ pid: process.pid, pid_started: written })).toBe(true);
});
it.skipIf(!psAvailable)("old reader accepts new lock and writer bytes equal pidStartFrom", () => {
  const lease = acquireProjectLock(tmp(), "compat");
  try {
    expect(oldLockHolderAlive(lease.info)).toBe(true);
    expect(lease.info.pid_started).toBe(pidStartFrom(process.pid, {
      platform: process.platform,
      readFile: p => { try { return fs.readFileSync(p, "utf8"); } catch { return undefined; } },
      ps: pid => inheritedPs(pid),
    }));
  } finally { lease.release(); }
});
it.skipIf(!psAvailable || !holderAvailable)("does not take over a live child's rewritten cross-zone lock", async () => {
  const root = tmp();
  const holder = startHolder(root, "cross-zone", 10_000);
  try {
    expect(await holder.first).toBe("ACQUIRED");
    const file = runLockFile(root, "cross-zone");
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    lock.pid_started = realPs(lock.pid, "Asia/Bangkok");
    expect(lock.pid_started).not.toBe("");
    fs.writeFileSync(file, JSON.stringify(lock));
    expect(() => acquireProjectLock(root, "cross-zone")).toThrow(/still running/);
  } finally {
    holder.child.kill();
    await holder.exited;
  }
}, 20_000);

describe("writer stays readable by old readers (fake ps, always runs)", () => {
  const instant = 1_793_000_000; // fixed epoch seconds
  const fakePsScript = `#!/bin/sh
# Fake macOS \`ps -o lstart= -p PID\`: prints the instant recorded in $FAKE_PS_DIR/PID in local time (honours TZ); zh text for a zh locale unless LC_ALL=C.
for a; do pid=$a; done
f="$FAKE_PS_DIR/$pid"; [ -f "$f" ] || exit 1
e=$(cat "$f")
fmt() { date -r "$e" "$1" 2>/dev/null || date -d "@$e" "$1"; }
loc=\${LC_ALL:-\${LC_TIME:-$LANG}}
case "$loc" in
  zh*) w=$(fmt +%u); set -- 一 二 三 四 五 六 日; eval wd=\\\${$w}; echo "$wd $(fmt '+%-m月/%e %H:%M:%S %Y')";;
  *) fmt '+%a %b %e %H:%M:%S %Y';;
esac
`;
  const keys = ["PATH", "FAKE_PS_DIR", "TZ", "LANG", "LC_ALL"] as const;
  const saved: Partial<Record<(typeof keys)[number], string | undefined>> = {};
  let psDir = "";
  const setEnv = (tz: string, lang: string) => {
    process.env.TZ = tz;
    process.env.LANG = lang;
    delete process.env.LC_ALL;
  };
  const setInstant = (epoch: number) => fs.writeFileSync(path.join(psDir, String(process.pid)), String(epoch));
  const darwinIo = (ps: PidStartIo["ps"]): PidStartIo => ({ platform: "darwin", readFile: () => undefined, ps });
  const readerIo = (): LivenessIo => ({ ...darwinIo(readerPs), signal0: signalAlive, psUtc: readerPsUtc });
  const write = () => pidStartFrom(process.pid, darwinIo(writerPs))!;
  const bangkokOrUtc = ["UTC", "Asia/Bangkok"];
  const langs = ["C", "zh_TW.UTF-8", "zh_CN.UTF-8"];
  const combos = langs.flatMap((l) => bangkokOrUtc.map((tz) => [l, tz] as const));

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    psDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-ps-"));
    dirs.push(psDir);
    const bin = path.join(psDir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "ps"), fakePsScript, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    process.env.FAKE_PS_DIR = psDir;
    setInstant(instant);
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it.each(combos)("lock written under %s / %s is alive for the old and the current reader", (lang, tz) => {
    setEnv(tz, lang);
    const written = write();
    const lock = { pid: process.pid, pid_started: written };
    expect(oldLockHolderAlive(lock as LockInfo)).toBe(true);
    expect(lockHolderAlive(lock, readerIo())).toBe(true);
    for (const [l2, tz2] of combos) {
      setEnv(tz2, l2);
      expect(lockHolderAlive(lock, readerIo())).toBe(true);
    }
  });

  it("the writer records the locale text as ps prints it, not a pinned C text", () => {
    setEnv("UTC", "zh_TW.UTF-8");
    expect(write()).toMatch(/月\//);
  });

  it.each(combos)("reused pid (different instant, +37 s) is dead for both readers under %s / %s", (lang, tz) => {
    setEnv(tz, lang);
    const lock = { pid: process.pid, pid_started: write() };
    setInstant(instant + 37);
    expect(lockHolderAlive(lock, readerIo())).toBe(false);
    if (process.platform !== "linux") expect(oldLockHolderAlive(lock as LockInfo)).toBe(false); // old reader compares /proc ticks on Linux
  });

  it("a gone pid is dead for both readers", () => {
    setEnv("Asia/Bangkok", "zh_TW.UTF-8");
    const lock = { pid: deadPid(), pid_started: write() };
    expect(lockHolderAlive(lock, readerIo())).toBe(false);
    expect(oldLockHolderAlive(lock as LockInfo)).toBe(false);
  });
});

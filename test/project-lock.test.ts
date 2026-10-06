import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProjectLock, forceUnlock, inspectProjectLock, lockHolderAlive, LOCK_FILE } from "../src/project-lock.js";

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
    const root = tmp();
    fs.writeFileSync(
      path.join(root, LOCK_FILE),
      JSON.stringify({ token: "old", hostname: os.hostname(), pid: process.pid, pid_started: "Thu Jan  1 00:00:00 1970", run_id: "old", heartbeat_at: new Date().toISOString(), acquired_at: new Date().toISOString() }),
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

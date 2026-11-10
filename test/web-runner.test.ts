import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listJobs, readJob, runShort, startJob, type CliLauncher } from "../web/src/server/runner.js";

let dir: string;
let cli: CliLauncher;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-runner-"));
  const fake = path.join(dir, "fake-cli.mjs");
  fs.writeFileSync(
    fake,
    [
      "const args = process.argv.slice(2);",
      "if (args.includes('SLOW')) await new Promise((r) => setTimeout(r, 300));",
      "if (args.includes('HANG')) await new Promise((r) => setTimeout(r, 60000));",
      "process.stdout.write(JSON.stringify({ args, cwd: process.cwd() }));",
      "process.stderr.write('err-line');",
      "if (args.includes('FAIL')) process.exit(3);",
    ].join("\n"),
  );
  cli = { execPath: process.execPath, args: [fake] };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
};

describe("runShort", () => {
  it("passes --home first and argv verbatim, in the given cwd", async () => {
    const r = await runShort(cli, "/h", ["run", "--", "a b; c"], { cwd: dir, timeoutMs: 5000 });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout) as { args: string[]; cwd: string };
    expect(out.args).toEqual(["--home", "/h", "run", "--", "a b; c"]);
    expect(fs.realpathSync(out.cwd)).toBe(fs.realpathSync(dir));
    expect(r.stderr).toBe("err-line");
  });
  it("reports the exit code", async () => {
    expect((await runShort(cli, "/h", ["FAIL"], { cwd: dir, timeoutMs: 5000 })).exit).toBe(3);
  });
  it("kills a command that runs too long", async () => {
    const r = await runShort(cli, "/h", ["HANG"], { cwd: dir, timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.exit).not.toBe(0);
  });
  it("resolves and leaves no process behind when the CLI ignores SIGTERM and a grandchild holds the pipes", async () => {
    const pidFile = path.join(dir, "gc.pid");
    const stubborn = path.join(dir, "stubborn.mjs");
    fs.writeFileSync(
      stubborn,
      [
        "import { spawn } from 'node:child_process';",
        "import fs from 'node:fs';",
        "process.on('SIGTERM', () => {});",
        `const gc = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)"], { stdio: 'inherit' });`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
        "setTimeout(() => {}, 60000);",
      ].join("\n"),
    );
    // The pid file is written after the SIGTERM handler is installed; start the clock only once the child is ready.
    const t0 = Date.now();
    const pending = runShort({ execPath: process.execPath, args: [stubborn] }, "/h", [], { cwd: dir, timeoutMs: 1500 });
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8") !== "", 1200);
    const r = await pending;
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5500);
    const gc = Number(fs.readFileSync(pidFile, "utf8"));
    await until(() => {
      try {
        process.kill(gc, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
  it("a missing executable is a result, not a throw", async () => {
    const r = await runShort({ execPath: path.join(dir, "nope"), args: [] }, "/h", [], { cwd: dir, timeoutMs: 1000 });
    expect(r.exit).toBeNull();
    expect(r.stderr).not.toBe("");
  });
});

describe("startJob", () => {
  it("returns at once, writes out.log and exit.json, and is listed", async () => {
    const jobsDir = path.join(dir, "web-jobs");
    const t0 = Date.now();
    const job = startJob(cli, "/h", jobsDir, "run", ["run", "SLOW"], dir);
    expect(Date.now() - t0).toBeLessThan(250);
    expect(job.pid).toBeGreaterThan(0);
    await until(() => readJob(jobsDir, job.id)?.state === "ended");
    const view = readJob(jobsDir, job.id);
    expect(view?.exit).toBe(0);
    expect(view?.command).toBe("run");
    expect(view?.tail).toContain('"SLOW"');
    expect(listJobs(jobsDir).map((j) => j.id)).toEqual([job.id]);
  });
  it("records a failing exit code", async () => {
    const jobsDir = path.join(dir, "web-jobs");
    const job = startJob(cli, "/h", jobsDir, "run", ["FAIL"], dir);
    await until(() => readJob(jobsDir, job.id)?.state === "ended");
    expect(readJob(jobsDir, job.id)?.exit).toBe(3);
  });
  it("a job whose process is gone and left no exit record is lost", () => {
    const jobsDir = path.join(dir, "web-jobs");
    fs.mkdirSync(path.join(jobsDir, "old-1"), { recursive: true });
    fs.writeFileSync(path.join(jobsDir, "old-1", "job.json"), JSON.stringify({ id: "old-1", command: "run", argv: [], cwd: dir, started_at: "2026-11-10T00:00:00.000Z", pid: 2147483646 }));
    expect(readJob(jobsDir, "old-1")?.state).toBe("lost");
  });
  it("rejects ids that could leave the jobs directory", () => {
    expect(readJob(path.join(dir, "web-jobs"), "../x")).toBeUndefined();
    expect(readJob(path.join(dir, "web-jobs"), "a/b")).toBeUndefined();
  });
  it("skips job records without a started_at", () => {
    const jobsDir = path.join(dir, "web-jobs");
    fs.mkdirSync(path.join(jobsDir, "bad1"), { recursive: true });
    fs.writeFileSync(path.join(jobsDir, "bad1", "job.json"), JSON.stringify({ id: "bad1", command: "run", pid: 0 }));
    fs.mkdirSync(path.join(jobsDir, "ok1"), { recursive: true });
    fs.writeFileSync(path.join(jobsDir, "ok1", "job.json"), JSON.stringify({ id: "ok1", command: "run", argv: [], cwd: dir, started_at: "2026-11-10T00:00:01.000Z", pid: 0 }));
    expect(listJobs(jobsDir).map((j) => j.id)).toEqual(["ok1"]);
  });
  it("lists newest first and caps the list", () => {
    const jobsDir = path.join(dir, "web-jobs");
    for (const [id, at] of [["a1", "2026-11-10T00:00:01.000Z"], ["b2", "2026-11-10T00:00:03.000Z"], ["c3", "2026-11-10T00:00:02.000Z"]] as const) {
      fs.mkdirSync(path.join(jobsDir, id), { recursive: true });
      fs.writeFileSync(path.join(jobsDir, id, "job.json"), JSON.stringify({ id, command: "run", argv: [], cwd: dir, started_at: at, pid: 0 }));
    }
    expect(listJobs(jobsDir).map((j) => j.id)).toEqual(["b2", "c3", "a1"]);
    expect(listJobs(jobsDir, 2).map((j) => j.id)).toEqual(["b2", "c3"]);
  });
});

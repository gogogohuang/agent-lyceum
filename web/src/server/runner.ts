import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** How to start the CLI: `execPath [...args, "--home", home, ...argv]`. `args` carries the script and any loader flags (tsx in dev). */
export type CliLauncher = { execPath: string; args: readonly string[] };

export type ShortResult = { exit: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };

const OUT_CAP = 1_000_000;
const TAIL_BYTES = 20_000;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function runShort(cli: CliLauncher, home: string, argv: string[], opts: { cwd: string; timeoutMs: number }): Promise<ShortResult> {
  return new Promise((resolve) => {
    const child = spawn(cli.execPath, [...cli.args, "--home", home, ...argv], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const take = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (next.length <= OUT_CAP) return next;
      truncated = true;
      return next.slice(0, OUT_CAP);
    };
    child.stdout.on("data", (c: Buffer) => {
      stdout = take(stdout, c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = take(stderr, c);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    let done = false;
    const finish = (exit: number | null, signal: string | null, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exit, signal, stdout, stderr: stderr + extra, timedOut, truncated });
    };
    child.on("error", (e) => finish(null, null, e.message));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export type JobRecord = { id: string; command: string; argv: string[]; cwd: string; started_at: string; pid: number };
export type JobView = JobRecord & { state: "running" | "ended" | "lost"; exit?: number | null; signal?: string | null; ended_at?: string };

/** Runs the real command and writes `exit.json` when it ends. Passed to `node -e`, so no extra file has to be found at runtime. */
const WRAPPER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[1];
const spec = JSON.parse(fs.readFileSync(path.join(dir, "spec.json"), "utf8"));
const done = (exit, signal) => fs.writeFileSync(path.join(dir, "exit.json"), JSON.stringify({ exit, signal, ended_at: new Date().toISOString() }));
const child = spawn(spec.execPath, spec.args, { cwd: spec.cwd, stdio: "inherit" });
child.on("error", (e) => { fs.appendFileSync(path.join(dir, "out.log"), String(e.message) + "\\n"); done(127, null); });
child.on("exit", (code, signal) => done(code, signal));
`;

export function startJob(cli: CliLauncher, home: string, jobsDir: string, command: string, argv: string[], cwd: string): JobRecord {
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const dir = path.join(jobsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify({ execPath: cli.execPath, args: [...cli.args, "--home", home, ...argv], cwd }));
  const log = fs.openSync(path.join(dir, "out.log"), "a");
  const child = spawn(process.execPath, ["-e", WRAPPER, dir], { cwd, detached: true, stdio: ["ignore", log, log], env: process.env });
  fs.closeSync(log);
  child.on("error", (e) => {
    fs.appendFileSync(path.join(dir, "out.log"), `${e.message}\n`);
    fs.writeFileSync(path.join(dir, "exit.json"), JSON.stringify({ exit: 127, signal: null, ended_at: new Date().toISOString() }));
  });
  child.unref();
  const record: JobRecord = { id, command, argv, cwd, started_at: new Date().toISOString(), pid: child.pid ?? 0 };
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(record));
  return record;
}

function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function view(dir: string): JobView | undefined {
  let record: JobRecord;
  try {
    record = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8")) as JobRecord;
  } catch {
    return undefined;
  }
  try {
    const ended = JSON.parse(fs.readFileSync(path.join(dir, "exit.json"), "utf8")) as { exit: number | null; signal: string | null; ended_at: string };
    return { ...record, state: "ended", exit: ended.exit, signal: ended.signal, ended_at: ended.ended_at };
  } catch {
    return { ...record, state: alive(record.pid) ? "running" : "lost" };
  }
}

export function listJobs(jobsDir: string, limit = 50): JobView[] {
  let names: string[];
  try {
    names = fs.readdirSync(jobsDir);
  } catch {
    return [];
  }
  const jobs = names.filter((n) => ID_RE.test(n)).flatMap((n) => view(path.join(jobsDir, n)) ?? []);
  return jobs.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit);
}

export function readJob(jobsDir: string, id: string): (JobView & { tail: string }) | undefined {
  if (!ID_RE.test(id)) return undefined;
  const dir = path.join(jobsDir, id);
  const found = view(dir);
  if (!found) return undefined;
  return { ...found, tail: tailOf(path.join(dir, "out.log")) };
}

function tailOf(file: string): string {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

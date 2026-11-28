import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tidyAdvice, writeTidyState } from "../src/memory-tidy.js";
import { buildStatusReport } from "../src/status.js";
import { buildWatchFrame, createStatusWatcher, type WatchFrame } from "../src/status-watch.js";
import { git, initGitRepo, makeMemoryEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
let restorePath: (() => void) | undefined;
const logFiles: string[] = [];

afterEach(() => {
  restorePath?.();
  restorePath = undefined;
  vi.restoreAllMocks();
  env?.cleanup();
  for (const file of logFiles.splice(0)) fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

function realGit(): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "git");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* next PATH entry */
    }
  }
  throw new Error("git is not on PATH");
}

/** Count git argv the process actually runs. The shim delegates to the real binary. */
function recordGit(): { lines: () => string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advice-git-"));
  const logFile = path.join(dir, "log");
  logFiles.push(logFile);
  const shim = path.join(dir, "git");
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(logFile)}\nexec ${quote(realGit())} "$@"\n`, { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${prev ?? ""}`;
  restorePath = () => {
    process.env.PATH = prev;
  };
  return { lines: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []) };
}

const mem = (agent: string) => env.project().agents[agent]!.memory.project!;

function arm(agent: string, head: string) {
  const dir = mem(agent);
  write(path.join(dir, "MEMORY.md"), "- [a](a.md)\n");
  writeTidyState(dir, { head, at: "2026-01-01T00:00:00Z" });
}

function counts(lines: string[]) {
  return {
    repo: lines.filter((l) => l.includes("rev-parse") && l.includes("--is-inside-work-tree")).length,
    list: lines.filter((l) => l.includes("rev-list") && l.includes("--count")).length,
  };
}

describe("tidyAdvice git calls", () => {
  it("checks the repository once and counts each shared baseline once", () => {
    env = makeMemoryEnv();
    initGitRepo(env.repo);
    const head = git(env.repo, "rev-parse", "HEAD");
    for (const agent of ["lead", "fe-member", "qa-member"]) arm(agent, head);
    const gitLog = recordGit();
    expect(tidyAdvice(env.project())).toEqual([]);
    expect(counts(gitLog.lines())).toEqual({ repo: 1, list: 1 });
  });

  it("counts a distinct baseline again, still with one repository check", () => {
    env = makeMemoryEnv();
    initGitRepo(env.repo);
    const first = git(env.repo, "rev-parse", "HEAD");
    write(path.join(env.repo, "later.txt"), "x\n");
    execFileSync("git", ["-C", env.repo, "add", "-A"]);
    execFileSync("git", ["-C", env.repo, "commit", "-q", "-m", "later"]);
    const second = git(env.repo, "rev-parse", "HEAD");
    arm("lead", first);
    arm("fe-member", first);
    arm("qa-member", second);
    const gitLog = recordGit();
    tidyAdvice(env.project());
    expect(counts(gitLog.lines())).toEqual({ repo: 1, list: 2 });
  });

  it("checks a non-repository once and does not run rev-list", () => {
    env = makeMemoryEnv();
    for (const agent of ["lead", "fe-member", "qa-member"]) arm(agent, "a".repeat(40));
    const gitLog = recordGit();
    expect(tidyAdvice(env.project())).toEqual([]);
    expect(counts(gitLog.lines())).toEqual({ repo: 1, list: 0 });
  });

  it("one-shot status asks again on the next report", () => {
    env = makeMemoryEnv();
    initGitRepo(env.repo);
    const head = git(env.repo, "rev-parse", "HEAD");
    for (const agent of ["lead", "fe-member", "qa-member"]) arm(agent, head);
    const gitLog = recordGit();
    expect(buildStatusReport(env.project()).memory_advice).toBeUndefined();
    expect(buildStatusReport(env.project()).memory_advice).toBeUndefined();
    expect(counts(gitLog.lines())).toEqual({ repo: 2, list: 2 });
  });
});

describe("watcher advice", () => {
  function writeRun(id: string) {
    write(
      path.join(env.project().paths.runs, id, "state.json"),
      JSON.stringify({ run_id: id, rounds: 1, max_rounds: 10, last_wake: {}, wakes: [], pid: process.pid }),
    );
  }

  it("reuses one advice computation across runs in a frame and across beats inside five minutes", () => {
    env = makeMemoryEnv();
    initGitRepo(env.repo);
    const head = git(env.repo, "rev-parse", "HEAD");
    for (const agent of ["lead", "fe-member", "qa-member"]) arm(agent, head);
    writeRun("20260101-000000");
    writeRun("20260102-000000");
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const gitLog = recordGit();
    const watcher = createStatusWatcher({
      load: () => env.project(),
      dir: (p) => p.paths.runs,
      write: () => {},
      debounceMs: 1_000,
      watch: () => ({ close() {} }),
    });
    try {
      watcher.beat();
      expect(counts(gitLog.lines())).toEqual({ repo: 1, list: 1 });
      now += 60_000;
      watcher.beat();
      expect(counts(gitLog.lines())).toEqual({ repo: 1, list: 1 });
      now += 5 * 60_000;
      watcher.beat();
      expect(counts(gitLog.lines())).toEqual({ repo: 2, list: 2 });
    } finally {
      watcher.close();
    }
  });

  it("shows advice refreshed at its own TTL on a finished report that is still cached", () => {
    env = makeMemoryEnv();
    const id = "20260101-000000";
    const statePath = path.join(env.project().paths.runs, id, "state.json");
    const body = { run_id: id, rounds: 4, max_rounds: 10, last_wake: {}, wakes: [], pid: process.pid };
    write(statePath, JSON.stringify(body));
    const memory = env.project().agents.lead?.memory.project;
    if (!memory) throw new Error("lead project memory is not configured");
    write(path.join(memory, "MEMORY.md"), "- [a](a.md)\n");
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const frames: WatchFrame[] = [];
    const watcher = createStatusWatcher({
      load: () => env.project(),
      dir: (p) => p.paths.runs,
      write: (line) => frames.push(JSON.parse(line) as WatchFrame),
      debounceMs: 1_000,
      allTasks: true,
      watch: () => ({ close() {} }),
    });
    try {
      watcher.beat();
      expect(frames.at(-1)?.runs?.[id].memory_advice).toBeUndefined();
      now += 4 * 60_000;
      write(statePath, JSON.stringify({ ...body, end_reason: "done", outcome: "completed" }));
      watcher.beat();
      expect(frames.at(-1)?.runs?.[id].run?.state).toBe("ended");
      expect(frames.at(-1)?.runs?.[id].memory_advice).toBeUndefined();
      write(path.join(memory, "MEMORY.md"), "x".repeat(5_000));
      now += 60_000 + 1;
      watcher.beat();
      expect(frames.at(-1)?.runs?.[id].memory_advice?.[0]).toContain("5000 bytes");
      expect(frames.at(-1)?.runs?.[id].run?.rounds).toBe(4);
    } finally {
      watcher.close();
    }
  });
});

describe("buildWatchFrame finished advice", () => {
  it("copies the current advice onto a cached finished report and keeps the built run", () => {
    env = makeMemoryEnv();
    const id = "20260101-000000";
    write(
      path.join(env.project().paths.runs, id, "state.json"),
      JSON.stringify({ run_id: id, rounds: 4, max_rounds: 10, last_wake: {}, wakes: [], pid: process.pid, end_reason: "done", outcome: "completed" }),
    );
    const cache = new Map();
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const oldAdvice = ["lead: 50 commits since the last tidy"];
    const first = buildWatchFrame(env.project(), new Set(), { allTasks: true, cache, advice: oldAdvice });
    expect(first.runs?.[id].memory_advice).toEqual(oldAdvice);
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    const nextAdvice = ["lead: 80 commits since the last tidy"];
    const second = buildWatchFrame(env.project(), new Set(), { allTasks: true, cache, advice: nextAdvice });
    expect(second.runs?.[id].memory_advice).toEqual(nextAdvice);
    expect(second.runs?.[id].run).toBe(first.runs?.[id].run);
    expect(second.report?.memory_advice).toEqual(nextAdvice);
    const third = buildWatchFrame(env.project(), new Set(), { allTasks: true, cache, advice: [] });
    expect(third.runs?.[id].memory_advice).toBeUndefined();
    expect(third.runs?.[id].run).toBe(first.runs?.[id].run);
  });
});

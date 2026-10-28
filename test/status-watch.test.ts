import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWatchFrame, createStatusWatcher, type WatchFrame } from "../src/status-watch.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => {
  env?.cleanup();
  vi.useRealTimers();
});

function writeRun(id: string, extra: Record<string, unknown> = {}) {
  write(path.join(env.project().paths.runs, id, "state.json"), JSON.stringify({ run_id: id, rounds: 1, max_rounds: 10, last_wake: {}, wakes: [], pid: process.pid, ...extra }));
}

describe("buildWatchFrame", () => {
  it("has one report per running run, and a run that ended since the last frame once more", () => {
    env = makeEnv();
    writeRun("20260101-000000");
    writeRun("20260102-000000");
    const tracked = new Set<string>();
    const first = buildWatchFrame(env.project(), tracked);
    expect(Object.keys(first.runs ?? {}).sort()).toEqual(["20260101-000000", "20260102-000000"]);
    expect(first.report?.project.name).toBe("demo");

    writeRun("20260101-000000", { end_reason: "done", outcome: "completed" });
    const second = buildWatchFrame(env.project(), tracked);
    expect(Object.keys(second.runs ?? {}).sort()).toEqual(["20260101-000000", "20260102-000000"]);
    expect(second.runs?.["20260101-000000"].run?.state).toBe("ended");

    const third = buildWatchFrame(env.project(), tracked);
    expect(Object.keys(third.runs ?? {})).toEqual(["20260102-000000"]);
  });
});

describe("buildWatchFrame keeps what is not completed", () => {
  it("lists interrupted, waiting and non-completed ended runs, and drops completed ones", () => {
    env = makeEnv();
    const dead = 2 ** 22 + 1; // no such process: the dispatcher is gone
    writeRun("20260101-000000", { pid: dead });
    writeRun("20260102-000000", { end_reason: "waiting" });
    writeRun("20260103-000000", { end_reason: "done", outcome: "partial" });
    writeRun("20260104-000000", { end_reason: "agent_failed", outcome: "failed" });
    writeRun("20260105-000000", { end_reason: "done", outcome: "completed" });
    const frame = buildWatchFrame(env.project(), new Set());
    expect(Object.keys(frame.runs ?? {}).sort()).toEqual(["20260101-000000", "20260102-000000", "20260103-000000", "20260104-000000"]);
    expect(frame.runs?.["20260101-000000"].run?.state).toBe("interrupted");
  });

  it("keeps completed runs when every task is requested", () => {
    env = makeEnv();
    writeRun("20260101-000000", { end_reason: "done", outcome: "completed" });
    writeRun("20260102-000000", { pid: 2 ** 22 + 1 });
    const frame = buildWatchFrame(env.project(), new Set(), { allTasks: true });
    expect(Object.keys(frame.runs ?? {}).sort()).toEqual(["20260101-000000", "20260102-000000"]);
  });
});

describe("createStatusWatcher", () => {
  function make() {
    vi.useFakeTimers();
    env = makeEnv();
    const lines: WatchFrame[] = [];
    let onChange = () => {};
    const closed = vi.fn();
    const watch = vi.fn((_dir: string, cb: () => void) => {
      onChange = cb;
      return { close: closed };
    });
    const w = createStatusWatcher({ load: () => env.project(), dir: (p) => p.paths.runs, write: (l) => lines.push(JSON.parse(l)), debounceMs: 100, watch });
    return { w, lines, watch, closed, fire: () => onChange() };
  }

  it("prints a frame on the first beat, and only again when it differs", () => {
    const m = make();
    m.w.beat();
    expect(m.lines).toHaveLength(1);
    m.w.beat();
    expect(m.lines).toHaveLength(1);
    writeRun("20260101-000000");
    m.w.beat();
    expect(m.lines).toHaveLength(2);
    expect(Object.keys(m.lines[1].runs ?? {})).toEqual(["20260101-000000"]);
  });

  it("starts the watcher only once the runs directory exists, and not twice", () => {
    const m = make();
    fs.rmSync(env.project().paths.runs, { recursive: true, force: true });
    m.w.beat();
    expect(m.watch).not.toHaveBeenCalled();
    writeRun("20260101-000000");
    m.w.beat();
    m.w.beat();
    expect(m.watch).toHaveBeenCalledTimes(1);
    expect(m.watch.mock.calls[0][0]).toBe(env.project().paths.runs);
  });

  it("debounces a burst of file events into one frame", () => {
    const m = make();
    writeRun("20260101-000000");
    m.w.beat();
    expect(m.lines).toHaveLength(1);
    writeRun("20260101-000000", { rounds: 2 });
    m.fire();
    m.fire();
    m.fire();
    vi.advanceTimersByTime(99);
    expect(m.lines).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(m.lines).toHaveLength(2);
    expect(m.lines[1].runs?.["20260101-000000"].run?.rounds).toBe(2);
  });

  it("reports a load failure as an error frame instead of throwing", () => {
    const m = make();
    fs.mkdirSync(env.project().paths.runs, { recursive: true });
    fs.writeFileSync(path.join(env.project().paths.runs, "x"), "");
    const w = createStatusWatcher({ load: () => { throw new Error("boom"); }, dir: () => "", write: (l) => m.lines.push(JSON.parse(l)), debounceMs: 1, watch: m.watch });
    w.beat();
    expect(m.lines.at(-1)).toEqual({ schema_version: 1, error: "boom" });
  });

  it("close stops the watcher and a pending frame", () => {
    const m = make();
    writeRun("20260101-000000");
    m.w.beat();
    m.fire();
    m.w.close();
    expect(m.closed).toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(m.lines).toHaveLength(1);
  });
});

it("beat recomputes lock liveness without a file event, including malformed-lock recovery", () => {
  env = makeEnv();
  const id = "20260101-000000";
  writeRun(id, { schema_version: 2 });
  const lock = path.join(env.project().paths.root, "locks", `${id}.json`);
  const frames: WatchFrame[] = [];
  const watcher = createStatusWatcher({
    load: () => env.project(), dir: p => p.paths.runs,
    write: line => frames.push(JSON.parse(line)),
    watch: () => ({ close() {} }),
  });
  const state = () => frames.at(-1)?.runs?.[id]?.run?.state;
  try {
    write(lock, '{"token":');
    watcher.beat();
    expect(state()).toBe("running");
    write(lock, JSON.stringify({ token: "test", pid: process.pid, run_id: id, acquired_at: "", heartbeat_at: "", hostname: "test" }));
    watcher.beat();
    expect(state()).toBe("running");
    expect(frames.every(f => f.runs?.[id]?.run?.state !== "interrupted")).toBe(true);
    write(lock, JSON.stringify({ token: "test", pid: 2 ** 22 + 1, run_id: id }));
    watcher.beat();
    expect(state()).toBe("interrupted");
    write(lock, JSON.stringify({ token: "test", pid: process.pid, run_id: id }));
    watcher.beat();
    expect(state()).toBe("running");
  } finally { watcher.close(); }
});

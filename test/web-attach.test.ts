import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WATCH_RESTART_EXIT } from "../src/code-change.js";
import type { MonitorDeps } from "../src/monitor-lifecycle.js";
import { runAttachedWeb, type AttachedWebDeps, type HealthProbe } from "../src/web-attach.js";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function make(over: Partial<AttachedWebDeps> = {}) {
  const log: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { destroyed: false, writable: true, write: vi.fn((s: string) => { log.push(`out:${s.trim()}`); return true; }) });
  const handlers = new Map<string, () => void>();
  const close = vi.fn(async () => { log.push("close"); });
  const exit = vi.fn((c: number) => { log.push(`exit:${c}`); });
  const errs: string[] = [];
  const startGate = deferred<{ url: string; close: () => Promise<void> }>();
  const deps: AttachedWebDeps = {
    start: vi.fn(() => startGate.promise),
    port: 8787,
    ppid: () => 10,
    startPpid: 10,
    stdout,
    stdin: Object.assign(new EventEmitter(), { isTTY: false, resume: vi.fn() }),
    onSignal: (s, h) => handlers.set(s, h),
    writeErr: (line) => errs.push(line),
    exit,
    fail: vi.fn(),
    probeHealth: vi.fn(async (): Promise<HealthProbe> => ({ kind: "timeout" })),
    intervalMs: 1000,
    monitor: vi.fn(),
    ...over,
  };
  return { deps, stdout, handlers, close, exit, errs, log, startGate, page: { url: "http://127.0.0.1:8787/", close } };
}

describe("runAttachedWeb", () => {
  it("a parent that already changed: no start, exit 129", async () => {
    const m = make({ ppid: () => 1 });
    await runAttachedWeb(m.deps);
    expect(m.deps.start).not.toHaveBeenCalled();
    expect(m.exit).toHaveBeenCalledWith(129);
  });

  it("SIGTERM during start: close after start resolves, exit 143, no URL", async () => {
    const m = make();
    const run = runAttachedWeb(m.deps);
    m.handlers.get("SIGTERM")?.();
    expect(m.exit).not.toHaveBeenCalled();
    m.startGate.resolve(m.page);
    await run;
    expect(m.log).toEqual(["close", "exit:143"]);
    expect(m.stdout.write).not.toHaveBeenCalled();
    expect(m.deps.monitor).not.toHaveBeenCalled();
  });

  it("handlers are registered before start is called", async () => {
    const order: string[] = [];
    const m = make({ onSignal: () => order.push("signal"), start: vi.fn(() => { order.push("start"); return new Promise(() => {}); }) });
    m.stdout.on = ((ev: string) => { order.push(`stdout:${ev}`); return m.stdout; }) as never;
    void runAttachedWeb(m.deps);
    expect(order.indexOf("start")).toBeGreaterThan(order.lastIndexOf("signal"));
    expect(order.indexOf("start")).toBeGreaterThan(order.indexOf("stdout:error"));
    expect(order.filter((o) => o === "signal")).toHaveLength(3);
  });

  it("stdout EPIPE during start: close, exit 0, no URL", async () => {
    const m = make();
    const run = runAttachedWeb(m.deps);
    m.stdout.emit("error", Object.assign(new Error("x"), { code: "EPIPE" }));
    m.startGate.resolve(m.page);
    await run;
    expect(m.log).toEqual(["close", "exit:0"]);
  });

  it("the parent changing during start: close, exit 129, no URL", async () => {
    let ppid = 10;
    const m = make({ ppid: () => ppid });
    const run = runAttachedWeb(m.deps);
    ppid = 1;
    m.startGate.resolve(m.page);
    await run;
    expect(m.log).toEqual(["close", "exit:129"]);
  });

  for (const [probe, line] of [
    [{ kind: "ours", pid: 4242, home: "/h" }, "status --web: port 8787 in use by agent-lyceum-web pid 4242 home /h\n"],
    [{ kind: "foreign" }, "status --web: port 8787 in use by another program\n"],
    [{ kind: "timeout" }, "status --web: port 8787 in use, no answer in 1 s\n"],
  ] as [HealthProbe, string][]) {
    it(`port in use (${probe.kind}): exactly one stderr line, exit 1`, async () => {
      const m = make({ probeHealth: vi.fn(async () => probe) });
      const run = runAttachedWeb(m.deps);
      m.startGate.reject(new Error("Port 8787 is already in use."));
      await run;
      expect(m.errs).toEqual([line]);
      expect(m.deps.probeHealth).toHaveBeenCalledWith(8787);
      expect(m.exit).toHaveBeenCalledWith(1);
    });
  }

  it("another start failure is reported as one line and exits 1", async () => {
    const m = make();
    const run = runAttachedWeb(m.deps);
    m.startGate.reject(new Error("listen EACCES: permission denied"));
    await run;
    expect(m.errs).toEqual(["status --web: listen EACCES: permission denied\n"]);
    expect(m.deps.probeHealth).not.toHaveBeenCalled();
    expect(m.exit).toHaveBeenCalledWith(1);
  });

  it("normal path: URL first via stdout.write, then the monitor with startPpid", async () => {
    const m = make();
    const run = runAttachedWeb(m.deps);
    m.startGate.resolve(m.page);
    await run;
    expect(m.log).toEqual(["out:http://127.0.0.1:8787/"]);
    expect(m.stdout.write).toHaveBeenCalledWith("http://127.0.0.1:8787/\n");
    const monitor = m.deps.monitor as ReturnType<typeof vi.fn>;
    expect(monitor).toHaveBeenCalledTimes(1);
    const md = monitor.mock.calls[0]?.[0] as MonitorDeps;
    expect(md.startPpid).toBe(10);
    expect(md.intervalMs).toBe(1000);
    md.draw();
    expect(m.log.at(-1)).toBe("out:"); // one blank line per heartbeat
    md.exit(129);
    await vi.waitFor(() => expect(m.exit).toHaveBeenCalledWith(129));
    expect(m.close).toHaveBeenCalledTimes(1);
  });

  it("a code change on disk: message, close, exit 75, and draws stop", async () => {
    let changed = false;
    const m = make({ changed: () => changed });
    const run = runAttachedWeb(m.deps);
    m.startGate.resolve(m.page);
    await run;
    const md = (m.deps.monitor as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as MonitorDeps;
    md.draw();
    expect(m.errs).toEqual([]);
    changed = true;
    md.draw();
    expect(m.errs).toEqual(["status --web: agent-lyceum code changed on disk; restart to load it\n"]);
    await vi.waitFor(() => expect(m.exit).toHaveBeenCalledWith(WATCH_RESTART_EXIT));
    const writes = m.stdout.write.mock.calls.length;
    md.draw();
    expect(m.stdout.write.mock.calls.length).toBe(writes);
  });

  it("uses the real monitor by default: a lost parent after start exits 129 at the first tick", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const m = make({ monitor: undefined, ppid: () => { calls.push(1); return calls.length <= 2 ? 10 : 1; } });
    const run = runAttachedWeb(m.deps);
    m.startGate.resolve(m.page);
    await vi.advanceTimersByTimeAsync(0);
    await run;
    await vi.advanceTimersByTimeAsync(0);
    expect(m.exit).toHaveBeenCalledWith(129);
  });
});

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMonitor, type MonitorDeps } from "../src/monitor-lifecycle.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");

describe("runMonitor (unit)", () => {
  afterEach(() => vi.useRealTimers());
  function make(over: Partial<MonitorDeps> = {}) {
    vi.useFakeTimers();
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, resume: vi.fn() });
    const stdout = Object.assign(new EventEmitter(), { destroyed: false, writable: true });
    const exit = vi.fn();
    const fail = vi.fn();
    const handlers = new Map<string, () => void>();
    const deps: MonitorDeps = {
      draw: vi.fn(), intervalMs: 1000, stdout, stdin, ppid: () => 10, exit, fail,
      onSignal: (s, h) => handlers.set(s, h), ...over,
    };
    runMonitor(deps);
    return { deps, stdin, stdout, exit, fail, handlers };
  }

  it("TTY stdin: resumes it, and end/close/error exit 0", () => {
    for (const ev of ["end", "close", "error"]) {
      const m = make();
      expect(m.stdin.resume).toHaveBeenCalled();
      m.stdin.emit(ev);
      expect(m.exit).toHaveBeenCalledWith(0);
      vi.advanceTimersByTime(5000);
      expect(m.deps.draw).toHaveBeenCalledTimes(1); // timer cleared
      vi.useRealTimers();
    }
  });

  it("non-TTY stdin: nothing attached, not read", () => {
    const m = make({ stdin: Object.assign(new EventEmitter(), { isTTY: false, resume: vi.fn() }) });
    expect(m.deps.stdin.listenerCount("end")).toBe(0);
    expect(m.deps.stdin.resume).not.toHaveBeenCalled();
    m.deps.stdin.emit("end");
    expect(m.exit).not.toHaveBeenCalled();
  });

  it("signals map to 130 / 143 / 129", () => {
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
      const m = make();
      m.handlers.get(sig)!();
      expect(m.exit).toHaveBeenCalledWith(code);
      vi.useRealTimers();
    }
  });

  it("stdout EPIPE/EIO exits 0; other errors fail; destroyed stdout exits 0 at a tick", () => {
    const a = make();
    a.stdout.emit("error", Object.assign(new Error("x"), { code: "EPIPE" }));
    expect(a.exit).toHaveBeenCalledWith(0);
    vi.useRealTimers();
    const b = make();
    b.stdout.emit("error", Object.assign(new Error("boom"), { code: "ENOSPC" }));
    expect(b.fail).toHaveBeenCalledWith("boom");
    expect(b.exit).not.toHaveBeenCalled();
    vi.useRealTimers();
    const c = make();
    c.stdout.destroyed = true;
    vi.advanceTimersByTime(1000);
    expect(c.exit).toHaveBeenCalledWith(0);
    vi.useRealTimers();
    const d = make();
    d.stdout.emit("error", Object.assign(new Error("x"), { code: "EIO" }));
    expect(d.exit).toHaveBeenCalledWith(0);
    vi.useRealTimers();
    const e = make();
    e.stdout.writable = false;
    vi.advanceTimersByTime(1000);
    expect(e.exit).toHaveBeenCalledWith(0);
    expect(e.deps.draw).toHaveBeenCalledTimes(1);
  });

  it("the stdout error handler is in place before the first draw", () => {
    const stdout = Object.assign(new EventEmitter(), { destroyed: false, writable: true });
    const draw = vi.fn(() => { stdout.emit("error", Object.assign(new Error("x"), { code: "EPIPE" })); });
    const m = make({ stdout, draw });
    expect(m.exit).toHaveBeenCalledWith(0);
    vi.advanceTimersByTime(5000);
    expect(draw).toHaveBeenCalledTimes(1); // no timer started after stopping
  });

  it("a changed parent pid exits 129 at the next tick", () => {
    let ppid = 10;
    const m = make({ ppid: () => ppid });
    ppid = 1;
    vi.advanceTimersByTime(1000);
    expect(m.exit).toHaveBeenCalledWith(129);
  });
});

describe("status --monitor process", () => {
  let env: TestEnv;
  const kids: ChildProcess[] = [];
  const pids: number[] = [];
  afterEach(() => {
    for (const k of kids.splice(0)) if (k.pid && alive(k.pid)) k.kill("SIGKILL");
    for (const p of pids.splice(0)) if (alive(p)) process.kill(p, "SIGKILL");
    env?.cleanup();
  });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(50); };
  const args = () => ["--import", "tsx", cli, "--home", env.home, "status", "-p", "demo", "--monitor", "--interval", "1"];
  async function start(stdin: "ignore" | "pipe" = "ignore") {
    env = makeEnv();
    const c = spawn(process.execPath, args(), { stdio: [stdin, "pipe", "pipe"] });
    kids.push(c);
    let err = "";
    c.stderr!.on("data", (d) => (err += d));
    await new Promise<void>((r) => c.stdout!.once("data", () => r()));
    return { c, err: () => err };
  }
  const exited = (c: ChildProcess) => new Promise<number | null>((r) => c.on("exit", (code) => r(code)));

  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    it(`${sig} exits ${code}`, async () => {
      const { c } = await start();
      c.kill(sig);
      expect(await exited(c)).toBe(code);
    }, 20000);
  }

  it("exits 0 without an EPIPE stack when the stdout reader goes away", async () => {
    const { c, err } = await start();
    c.stdout!.destroy();
    expect(await exited(c)).toBe(0);
    expect(err()).not.toMatch(/Unhandled 'error'|EPIPE/);
  }, 20000);

  it("exits 129 when its parent is gone", async () => {
    env = makeEnv();
    // The monitor writes to a file (not a pipe), so losing the parent cannot end it through EPIPE.
    // The middle process reports the pid only after the first draw, when the start ppid is recorded.
    const out = path.join(env.home, "monitor-out.txt");
    const script = `const fs=require("fs");const {spawn}=require("child_process");const F=${JSON.stringify(out)};const fd=fs.openSync(F,"w");const c=spawn(process.execPath,${JSON.stringify(args())},{stdio:["ignore",fd,"ignore"]});const t=setInterval(()=>{if(fs.statSync(F).size>0){clearInterval(t);console.log(c.pid);setInterval(()=>{},1000)}},50)`;
    const mid = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    kids.push(mid);
    const pid = await new Promise<number>((r) => mid.stdout!.once("data", (d) => r(Number(String(d).trim()))));
    pids.push(pid);
    expect(alive(pid)).toBe(true);
    mid.kill("SIGHUP");
    await until(() => !alive(pid), 4000);
    expect(alive(pid)).toBe(false);
  }, 20000);

  it("keeps running when a non-TTY stdin is closed", async () => {
    const { c } = await start("pipe");
    c.stdin!.end();
    await sleep(2500);
    expect(alive(c.pid!)).toBe(true);
    c.kill("SIGKILL");
  }, 20000);
});

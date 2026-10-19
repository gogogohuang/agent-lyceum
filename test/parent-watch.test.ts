import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startedByWrapper, watchParent } from "../src/parent-watch.js";
import { listRunLocks } from "../src/project-lock.js";
import { loadRunState } from "../src/run-store.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

describe("startedByWrapper", () => {
  it("is true under npm/npx (npm_execpath) or the tsx CLI (preflight), false otherwise", () => {
    expect(startedByWrapper({ npm_execpath: "/x/npm-cli.js" }, [])).toBe(true);
    expect(startedByWrapper({}, ["--require", "/p/node_modules/tsx/dist/preflight.cjs", "--import", "file:///p/node_modules/tsx/dist/loader.mjs"])).toBe(true);
    expect(startedByWrapper({}, [])).toBe(false);
    expect(startedByWrapper({}, ["--import", "tsx"])).toBe(false);
    expect(startedByWrapper({ npm_execpath: "" }, [])).toBe(false);
  });
});

describe("watchParent", () => {
  afterEach(() => vi.useRealTimers());

  it("calls onGone once, at the first tick after the parent pid changes", () => {
    vi.useFakeTimers();
    let ppid = 10;
    const onGone = vi.fn();
    watchParent(onGone, { startPpid: 10, ppid: () => ppid });
    vi.advanceTimersByTime(3000);
    expect(onGone).not.toHaveBeenCalled();
    ppid = 1;
    vi.advanceTimersByTime(1000);
    expect(onGone).toHaveBeenCalledTimes(1);
    ppid = 2;
    vi.advanceTimersByTime(5000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("calls onGone at once when the parent is already gone when armed", () => {
    const onGone = vi.fn();
    watchParent(onGone, { startPpid: 10, ppid: () => 1 });
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("stops when told to, and its timer does not keep the process alive", () => {
    vi.useFakeTimers();
    let ppid = 10;
    const onGone = vi.fn();
    const spy = vi.spyOn(globalThis, "setInterval");
    const stop = watchParent(onGone, { startPpid: 10, ppid: () => ppid });
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    stop();
    ppid = 1;
    vi.advanceTimersByTime(5000);
    expect(onGone).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("the CLI when its launcher exits", { timeout: 90_000 }, () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.join(here, "..", "src", "cli.ts");
  const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");
  let env: TestEnv;
  const pids: number[] = [];
  const kids: ChildProcess[] = [];
  afterEach(() => {
    for (const p of pids.splice(0)) if (alive(p)) process.kill(p, "SIGKILL");
    for (const k of kids.splice(0)) if (k.pid && alive(k.pid)) k.kill("SIGKILL");
    env?.cleanup();
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond: () => boolean, ms = 15000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await sleep(50);
  };

  /**
   * A middle process (standing in for npx or the tsx wrapper) starts the CLI, prints its pid at once, then `ready`
   * once the fake runtime is running. The CLI writes to files, not pipes, so the middle process dying cannot end it
   * through EPIPE; a preload records its exit code, since nobody is left to see it.
   * `armed` sets npm_execpath as npx does; otherwise every npm_* variable (set by `npm test`) is removed.
   */
  async function launch(args: (e: TestEnv) => string[], armed: boolean, prepare?: (e: TestEnv) => void, extra: Record<string, string> = {}) {
    env = makeEnv();
    prepare?.(env);
    const bin = path.join(env.root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
    const marker = path.join(env.root, "marker.json");
    const out = path.join(env.root, "cli.out");
    const err = path.join(env.root, "cli.err");
    const code = path.join(env.root, "cli.exit");
    const preload = path.join(env.root, "exit-code.mjs");
    fs.writeFileSync(preload, `import fs from "node:fs";\nprocess.on("exit", (c) => fs.writeFileSync(${JSON.stringify(code)}, String(c)));\n`);
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("npm_")) vars[k] = v;
    Object.assign(vars, { PATH: `${bin}:${process.env.PATH}`, FAKE_MODE: "sleep", FAKE_MARKER: marker, ...extra }, armed ? { npm_execpath: "/fake/npm-cli.js" } : {});
    const cliArgs = ["--import", preload, "--import", "tsx", cli, "--home", env.home, ...args(env)];
    const script = `const fs=require("fs");const {spawn}=require("child_process");
const c=spawn(process.execPath,${JSON.stringify(cliArgs)},{env:${JSON.stringify(vars)},stdio:["ignore",fs.openSync(${JSON.stringify(out)},"w"),fs.openSync(${JSON.stringify(err)},"w")]});
console.log("pid "+c.pid);
const t=setInterval(()=>{try{if(fs.statSync(${JSON.stringify(marker)}).size>0){clearInterval(t);console.log("ready")}}catch{}},50);setInterval(()=>{},1000)`;
    const mid = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    kids.push(mid);
    let said = "";
    mid.stdout!.on("data", (d) => (said += d));
    let pid = 0;
    const ready = await new Promise<boolean>((resolve) => {
      const end = Date.now() + 20_000;
      const t = setInterval(() => {
        const m = /pid (\d+)/.exec(said);
        if (m && !pid) {
          pid = Number(m[1]);
          pids.push(pid); // registered at once, so afterEach can always kill it
        }
        if (/ready/.test(said) || Date.now() > end || mid.exitCode !== null) {
          clearInterval(t);
          resolve(/ready/.test(said));
        }
      }, 50);
    });
    if (!ready) throw new Error(`the CLI did not start its agent: ${fs.existsSync(err) ? fs.readFileSync(err, "utf8") : "(no stderr)"}`);
    const runtime = JSON.parse(fs.readFileSync(marker, "utf8")) as { pid: number; grandchild: number };
    pids.push(runtime.pid, runtime.grandchild);
    const exitCode = () => (fs.existsSync(code) ? Number(fs.readFileSync(code, "utf8")) : undefined);
    return { mid, pid, runtime, err: () => fs.readFileSync(err, "utf8"), exitCode };
  }

  it("run: cancels cleanly (agents stopped, lock released, state cancelled) when the launcher exits", async () => {
    const l = await launch(() => ["run", "do it", "-p", "demo"], true);
    expect(listRunLocks(env.project().paths.root).length > 0).toBe(true);
    l.mid.kill("SIGHUP");
    await until(() => !alive(l.pid) && !alive(l.runtime.pid) && !alive(l.runtime.grandchild));
    expect(alive(l.pid)).toBe(false);
    expect(alive(l.runtime.pid)).toBe(false);
    expect(alive(l.runtime.grandchild)).toBe(false);
    expect(listRunLocks(env.project().paths.root).length > 0).toBe(false);
    const runs = env.project().paths.runs;
    const [id] = fs.readdirSync(runs);
    expect(loadRunState(path.join(runs, id!)).end_reason).toBe("cancelled");
    expect(l.err()).toMatch(/Launcher exited/);
    await until(() => l.exitCode() !== undefined, 5000);
    expect(l.exitCode()).toBe(130);
  });

  it("call: stops the agent and releases the call lock when the launcher exits", async () => {
    const l = await launch((e) => ["call", "pm", "go", "--dir", e.repo], true, (e) => {
      // `call` wakes a global-only agent
      write(path.join(e.home, "agents", "pm", "AGENT.md"), "# pm\n\nYou clarify requirements.\n");
      fs.appendFileSync(path.join(e.home, "team.yaml"), "  pm:\n    runtime: claude-code\n    agent_md: agents/pm/AGENT.md\n    memory: { global: agents/pm/memory }\n");
    });
    l.mid.kill("SIGHUP");
    await until(() => !alive(l.pid) && !alive(l.runtime.pid));
    expect(alive(l.pid)).toBe(false);
    expect(alive(l.runtime.pid)).toBe(false);
    expect(fs.existsSync(path.join(env.home, "calls", ".lock-pm"))).toBe(false);
    expect(l.err()).toMatch(/Launcher exited/);
  });

  it("a signal after the launcher exited quits at once, without waiting for the clean cancel", async () => {
    // the runtime ignores SIGTERM, so the clean cancel waits out the 5 s kill grace; a signal must not wait for it
    const l = await launch(() => ["run", "do it", "-p", "demo"], true, undefined, { FAKE_IGNORE_TERM: "1" });
    l.mid.kill("SIGHUP");
    await until(() => /Launcher exited/.test(l.err()), 5000);
    expect(l.err()).toMatch(/Launcher exited/);
    await sleep(500);
    expect(alive(l.pid)).toBe(true); // still stopping
    const t0 = Date.now();
    process.kill(l.pid, "SIGINT");
    await until(() => !alive(l.pid), 5000);
    expect(alive(l.pid)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2500);
    await until(() => l.exitCode() !== undefined, 2000);
    expect(l.exitCode()).toBe(130);
    await until(() => !alive(l.runtime.pid) && !alive(l.runtime.grandchild), 5000);
    expect(alive(l.runtime.pid)).toBe(false); // the exit hook still kills the runtime tree
  });

  it("a launcher exit while a signal's cancel is running does not quit early: the clean cancel finishes with 130", async () => {
    // the runtime ignores SIGTERM, so the cancel started by the signal takes the 5 s kill grace
    const l = await launch(() => ["run", "do it", "-p", "demo"], true, undefined, { FAKE_IGNORE_TERM: "1" });
    process.kill(l.pid, "SIGINT");
    await until(() => /Interrupted/.test(l.err()), 5000);
    l.mid.kill("SIGHUP");
    await sleep(2000); // two watch intervals
    expect(alive(l.pid)).toBe(true); // still in the clean cancel, not cut short
    expect(l.err()).not.toMatch(/Launcher exited/);
    await until(() => !alive(l.pid), 20_000);
    expect(alive(l.pid)).toBe(false);
    expect(l.exitCode()).toBe(130);
    const runs = env.project().paths.runs;
    const [id] = fs.readdirSync(runs);
    expect(loadRunState(path.join(runs, id!)).end_reason).toBe("cancelled");
  });

  it("is not armed when started directly: the run keeps going after its parent exits", async () => {
    const l = await launch(() => ["run", "do it", "-p", "demo"], false);
    l.mid.kill("SIGHUP");
    await sleep(3000);
    expect(alive(l.pid)).toBe(true);
    expect(alive(l.runtime.pid)).toBe(true);
    expect(l.err()).not.toMatch(/Launcher exited/);
  });
});

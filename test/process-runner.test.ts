import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Invocation } from "../src/adapters/types.js";
import { runInvocation, TAIL_BYTES } from "../src/process-runner.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "runtime", "process-tree.mjs");
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const inv = (mode: string, pidFile?: string, extra: Partial<Invocation> = {}): Invocation => ({
  cmd: process.execPath,
  args: [fixture, mode, ...(pidFile ? [pidFile] : [])],
  stdin: "",
  cwd: os.tmpdir(),
  parse: ({ stdout, code }) => ({ ok: code === 0, text: stdout.slice(-200), error: code === 0 ? undefined : `exit ${code}` }),
  ...extra,
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readPid = (f: string) => Number(fs.readFileSync(f, "utf8"));
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};

describe("runInvocation", () => {
  it("returns what the adapter parses from a normal run, and writes the full output to log files", async () => {
    const logDir = tmp();
    const r = await runInvocation(inv("ok"), { timeoutSec: 20, logDir });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(logDir, "stdout.log"), "utf8")).toContain('"result":"hello"');
    expect(fs.existsSync(path.join(logDir, "stderr.log"))).toBe(true);
  });

  it("hands the adapter each stdout line as it arrives, so bad JSON lines cannot break it", async () => {
    const seen: string[] = [];
    const r = await runInvocation(
      inv("ok", undefined, {
        stream: () => ({
          line: (l) => seen.push(l),
          finish: ({ code }) => ({ ok: code === 0, text: seen.filter((l) => l.startsWith("{")).at(-1) ?? "" }),
        }),
      }),
      { timeoutSec: 20, logDir: tmp() },
    );
    expect(seen).toEqual(["not json", '{"result":"hello","session_id":"s1","usage":{"output_tokens":7}}']);
    expect(r.text).toContain("hello");
  });

  it("reports a missing binary once, with a hint", async () => {
    const r = await runInvocation({ ...inv("ok"), cmd: "definitely-not-a-real-binary-xyz" }, { timeoutSec: 5, logDir: tmp() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found on PATH/);
  });

  it("reports a failing exit with the stderr tail", async () => {
    const r = await runInvocation(inv("fail"), { timeoutSec: 20, logDir: tmp() });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
  });

  it("on timeout, ends within a bounded time even if a grandchild holds the output pipe, and kills the whole tree", async () => {
    const pidFile = path.join(tmp(), "gc.pid");
    const t0 = Date.now();
    const r = await runInvocation(inv("hang", pidFile), { timeoutSec: 1, logDir: tmp(), killGraceMs: 200, settleWaitMs: 300 });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
    const gc = readPid(pidFile);
    await until(() => !alive(gc));
    expect(alive(gc)).toBe(false);
  }, 15_000);

  it("on cancel, stops at once, marks the result cancelled and leaves no process behind", async () => {
    const pidFile = path.join(tmp(), "gc.pid");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 600);
    const t0 = Date.now();
    const r = await runInvocation(inv("hang", pidFile), { timeoutSec: 60, signal: ac.signal, logDir: tmp(), killGraceMs: 200, settleWaitMs: 300 });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.cancelled).toBe(true);
    expect(r.ok).toBe(false);
    const gc = readPid(pidFile);
    await until(() => !alive(gc));
    expect(alive(gc)).toBe(false);
  }, 15_000);

  it("does not start anything when it is already cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    const pidFile = path.join(tmp(), "never.pid");
    const r = await runInvocation(inv("hang", pidFile), { timeoutSec: 60, signal: ac.signal, logDir: tmp() });
    expect(r.cancelled).toBe(true);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("escalates to SIGKILL for a process that ignores SIGTERM", async () => {
    const pidFile = path.join(tmp(), "gc.pid");
    const r = await runInvocation(inv("ignore-term", pidFile), { timeoutSec: 1, logDir: tmp(), killGraceMs: 300, settleWaitMs: 300 });
    expect(r.timedOut).toBe(true);
    const self = readPid(pidFile + ".self");
    await until(() => !alive(self));
    expect(alive(self)).toBe(false);
    expect(alive(readPid(pidFile))).toBe(false);
  }, 15_000);

  it("finishes when the runtime exits but a grandchild keeps stdout open, and cleans the grandchild up", async () => {
    const pidFile = path.join(tmp(), "gc.pid");
    const t0 = Date.now();
    const r = await runInvocation(inv("orphan", pidFile), { timeoutSec: 60, logDir: tmp(), killGraceMs: 200, settleWaitMs: 300 });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("done early");
    const gc = readPid(pidFile);
    await until(() => !alive(gc));
    expect(alive(gc)).toBe(false);
  }, 15_000);

  it("keeps at most 64 KiB of a 100 MiB output in memory, writes all of it to the log, and still finds the final result", async () => {
    const logDir = tmp();
    let tailSeen = 0;
    let lastResult = "";
    const r = await runInvocation(
      inv("flood", undefined, {
        parse: ({ stdout, stderr, code }) => {
          tailSeen = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
          return { ok: code === 0, text: stdout };
        },
        stream: () => ({
          line: (l) => {
            if (l.startsWith('{"result"')) lastResult = l;
          },
          finish: ({ code, stdoutTail, stderrTail }) => {
            tailSeen = Buffer.byteLength(stdoutTail) + Buffer.byteLength(stderrTail);
            return { ok: code === 0, text: lastResult };
          },
        }),
      }),
      { timeoutSec: 60, logDir },
    );
    expect(r.ok).toBe(true);
    expect(r.text).toBe('{"result":"tail result"}');
    expect(tailSeen).toBeLessThanOrEqual(TAIL_BYTES * 2);
    expect(fs.statSync(path.join(logDir, "stdout.log")).size).toBeGreaterThanOrEqual(100 * 1024 * 1024);
  }, 60_000);

  it("settles only once however the events fall", async () => {
    let calls = 0;
    const p = runInvocation(inv("ok"), { timeoutSec: 20, logDir: tmp() }).then((r) => {
      calls++;
      return r;
    });
    await p;
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(1);
  });
});

describe("process fixture sanity", () => {
  it("is runnable", () => {
    expect(spawnSync(process.execPath, [fixture, "ok"]).status).toBe(0);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeQuota } from "../src/quota.js";

// These tests spawn a real child through a `claude` shim on PATH. They show what abort does: it requests termination
// with SIGTERM. They do not show that the child is reclaimed.
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let pidFile: string;
const oldPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = oldPath;
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  } catch {
    /* never started */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function shim(body: string) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-sigterm-"));
  pidFile = path.join(dir, "pid");
  const file = path.join(dir, "claude");
  fs.writeFileSync(file, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${body}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
}

async function started(): Promise<number> {
  for (let i = 0; i < 100; i++) {
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      if (pid) return pid;
    } catch {
      /* not yet */
    }
    await sleep(50);
  }
  throw new Error("shim did not start");
}

describe("quota abort sends SIGTERM (request termination, not reclaim)", { timeout: 20_000 }, () => {
  it("a cooperative child exits after the abort request", async () => {
    shim("");
    const controller = new AbortController();
    const pending = claudeQuota(controller.signal);
    const settled = pending.catch((e: Error) => e);
    const pid = await started();
    controller.abort();
    expect(await settled).toMatchObject({ name: "AbortError" });
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
    expect(alive(pid)).toBe(false);
  });

  it("known leftover case: a child that ignores SIGTERM stays alive after the abort request", async () => {
    shim('process.on("SIGTERM", () => {});');
    const controller = new AbortController();
    const settled = claudeQuota(controller.signal).catch((e: Error) => e);
    const pid = await started();
    controller.abort();
    expect(await settled).toMatchObject({ name: "AbortError" });
    await sleep(500);
    expect(alive(pid)).toBe(true); // best-effort only; the afterEach hook ends it with SIGKILL
  });
});

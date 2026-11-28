import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(here, "fixtures", "runtime");
const claude = path.join(runtime, "fake-claude.mjs");
const codex = path.join(runtime, "fake-codex.mjs");
const tree = path.join(runtime, "process-tree.mjs");

const children: ChildProcess[] = [];
const dirs: string[] = [];
const pidFiles: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) if (typeof child.pid === "number") kill(child.pid);
  for (const file of pidFiles.splice(0)) {
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      const pid = text.startsWith("{") ? Number(JSON.parse(text).grandchild) : Number(text);
      if (pid) kill(pid);
    } catch {
      /* the fixture never wrote it */
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function kill(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitDead(pid: number) {
  for (let i = 0; i < 40; i++) {
    if (!alive(pid)) return;
    await delay(50);
  }
  kill(pid);
  throw new Error(`pid ${pid} was still alive`);
}

async function exited(child: ChildProcess, ms = 2_000): Promise<number | "timeout"> {
  children.push(child);
  const result = await Promise.race([
    once(child, "exit").then(([code]) => code as number | null),
    delay(ms).then(() => "timeout" as const),
  ]);
  if (result === "timeout") {
    if (typeof child.pid === "number") kill(child.pid);
    return "timeout";
  }
  return result ?? "timeout";
}

describe("forever-sleep fixtures exit on their own", () => {
  it("fake-claude sleep and its grandchild exit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-life-"));
    dirs.push(dir);
    const marker = path.join(dir, "marker");
    pidFiles.push(marker);
    const child = spawn(process.execPath, [claude], {
      env: { ...process.env, FAKE_MODE: "sleep", FAKE_MARKER: marker, FIXTURE_MAX_MS: "200" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stdin.end("");
    expect(await exited(child)).toBe(0);
    await waitDead(Number(JSON.parse(fs.readFileSync(marker, "utf8")).grandchild));
  });

  it("fake-codex timeout and its grandchild exit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-life-"));
    dirs.push(dir);
    const marker = path.join(dir, "marker");
    pidFiles.push(marker);
    const child = spawn(process.execPath, [codex], {
      env: { ...process.env, FAKE_FAIL: "timeout", FAKE_MARKER: marker, FIXTURE_MAX_MS: "200" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stdin.end("");
    expect(await exited(child)).toBe(0);
    await waitDead(Number(JSON.parse(fs.readFileSync(marker, "utf8")).grandchild));
  });

  it("process-tree hang exits, and an orphaned grandchild does too", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-life-"));
    dirs.push(dir);
    const hangPid = path.join(dir, "hang");
    pidFiles.push(hangPid);
    const hang = spawn(process.execPath, [tree, "hang", hangPid], {
      env: { ...process.env, FIXTURE_MAX_MS: "200" },
      stdio: "ignore",
    });
    expect(await exited(hang)).toBe(0);
    await waitDead(Number(fs.readFileSync(hangPid, "utf8")));

    const orphanPid = path.join(dir, "orphan");
    pidFiles.push(orphanPid);
    const orphan = spawn(process.execPath, [tree, "orphan", orphanPid], {
      env: { ...process.env, FIXTURE_MAX_MS: "200" },
      stdio: "ignore",
    });
    expect(await exited(orphan)).toBe(0);
    await waitDead(Number(fs.readFileSync(orphanPid, "utf8")));
  });
});

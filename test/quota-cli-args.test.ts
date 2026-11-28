import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { claudeQuota, codexQuota } from "../src/quota.js";

const CLAUDE_OLD = ["-p", "--no-session-persistence", "--output-format", "text", "/usage"];
const CLAUDE_NEW = ["--safe-mode", ...CLAUDE_OLD];
const CODEX_OLD = ["app-server", "--stdio"];
const CODEX_NEW = ["app-server", "--disable", "plugins", "--stdio"];
const USAGE = "Current session: 12% used \u00B7 resets 3pm\nCurrent week: 40% used \u00B7 resets Mon 9am\n";

afterEach(() => {
  spawnMock.mockReset();
  vi.useRealTimers();
});

function baseChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write: vi.fn() },
    kill: vi.fn(),
  });
}

function closeWith(stderr: string, code: number) {
  const child = baseChild();
  queueMicrotask(() => {
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  });
  return child;
}

function claudeOk() {
  const child = baseChild();
  queueMicrotask(() => {
    child.stdout.emit("data", USAGE);
    child.emit("close", 0);
  });
  return child;
}

function codexOk() {
  const child = baseChild();
  child.stdin.write = (line: string) => {
    const msg = JSON.parse(String(line)) as { id?: number };
    if (msg.id === 1) child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
    if (msg.id === 2) {
      child.stdout.emit(
        "data",
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_700_000_000 } } } })}\n`,
      );
    }
    return true;
  };
  return child;
}

describe("quota CLI arguments", () => {
  it("asks claude with --safe-mode and falls back when that option is unknown", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => (args[0] === "--safe-mode" ? closeWith("error: unknown option '--safe-mode'\n", 1) : claudeOk()));
    const report = await claudeQuota();
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([CLAUDE_NEW, CLAUDE_OLD]);
    expect(report.windows.map((w) => w.used_percent)).toEqual([12, 40]);
    expect(report.error).toBeUndefined();
  });

  it("asks codex with plugins disabled and falls back when that argument is unexpected", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => (args.includes("--disable") ? closeWith("error: unexpected argument '--disable' found\n", 1) : codexOk()));
    const report = await codexQuota();
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([CODEX_NEW, CODEX_OLD]);
    expect(report.windows[0]).toMatchObject({ used_percent: 10 });
    expect(report.error).toBeUndefined();
  });

  it("does not fall back when claude fails for a reason other than the new option", async () => {
    spawnMock.mockImplementation(() => closeWith("Invalid API key\n", 1));
    const report = await claudeQuota();
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([CLAUDE_NEW]);
    expect(report.windows).toEqual([]);
    expect(report.error).toContain("Invalid API key");
  });

  it("does not fall back when a quota command times out", async () => {
    vi.useFakeTimers();
    spawnMock.mockImplementation(() => baseChild());
    const claude = claudeQuota();
    const codex = codexQuota();
    await vi.advanceTimersByTimeAsync(20_000);
    const [claudeReport, codexReport] = await Promise.all([claude, codex]);
    expect(claudeReport.error).toMatch(/20 秒/);
    expect(codexReport.error).toMatch(/20 秒/);
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([CLAUDE_NEW, CODEX_NEW]);
  });

  it("does not fall back when the attempt is aborted", async () => {
    const abortChild = (options: { signal?: AbortSignal }) => {
      const child = baseChild();
      options.signal?.addEventListener("abort", () => child.emit("error", Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
      return child;
    };
    spawnMock.mockImplementation((_cmd: string, _args: string[], options: { signal?: AbortSignal }) => abortChild(options));
    const claudeAbort = new AbortController();
    const codexAbort = new AbortController();
    const claudePending = claudeQuota(claudeAbort.signal);
    const codexPending = codexQuota(codexAbort.signal);
    claudeAbort.abort();
    codexAbort.abort();
    await expect(claudePending).rejects.toMatchObject({ name: "AbortError" });
    await expect(codexPending).rejects.toMatchObject({ name: "AbortError" });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([CLAUDE_NEW, CODEX_NEW]);
  });
});

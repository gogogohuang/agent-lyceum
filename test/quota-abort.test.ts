import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { claudeQuota, codexQuota } from "../src/quota.js";

/** A fake child that emits `error` (AbortError) when the spawn `signal` aborts, like Node's real spawn. */
function fakeChild(options: { signal?: AbortSignal }) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write: vi.fn() },
    kill: vi.fn(),
  });
  options.signal?.addEventListener("abort", () => child.emit("error", Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })));
  return child;
}

describe("quota request termination", () => {
  for (const [name, fn] of [["claudeQuota", claudeQuota], ["codexQuota", codexQuota]] as const) {
    it(`${name} passes its signal to spawn and rejects with AbortError after abort`, async () => {
      spawnMock.mockReset();
      spawnMock.mockImplementation((_cmd: string, _args: string[], options: { signal?: AbortSignal }) => fakeChild(options));
      const controller = new AbortController();
      const pending = fn(controller.signal);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });

    it(`${name} without a signal still resolves an error report when the command is missing`, async () => {
      spawnMock.mockReset();
      spawnMock.mockImplementation(() => {
        const child = fakeChild({});
        queueMicrotask(() => child.emit("error", Object.assign(new Error("x"), { code: "ENOENT" })));
        return child;
      });
      const report = await fn();
      expect(report.error).toContain("找不到");
    });
  }
});

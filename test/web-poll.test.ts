import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPoll } from "../web/src/client/poll";

describe("startPoll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not overlap requests and stops cleanly", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const results: number[] = [];
    const stop = startPoll(
      () => {
        calls++;
        return new Promise<number>((r) => {
          release = () => r(calls);
        });
      },
      (v) => results.push(v),
      1000,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1);
    release?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    expect(results).toEqual([1]);
    stop();
    release?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
    expect(results).toEqual([1]);
  });

  it("keeps polling after a rejected fetch", async () => {
    let calls = 0;
    const stop = startPoll(
      async () => {
        calls++;
        throw new Error("x");
      },
      () => {},
      1000,
    );
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toBe(3);
    stop();
  });
});

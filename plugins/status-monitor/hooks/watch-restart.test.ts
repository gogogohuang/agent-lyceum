import { expect, it, vi } from "vitest";
import { superviseWatch, WATCH_RESTART_PREFIX as marker } from "./watch-restart";

it.each([
  [[marker, "ended"], 2],
  [["ended"], 1],
  [[new Error("failed")], 1],
  [[new Error(marker)], 1],
  [[marker, "SyntaxError: Unexpected end of input"], 2],
] as const)("restarts resolved markers only then registers polling once: %s", async (script, calls) => {
  let index = 0;
  const follow = vi.fn(async () => {
    const item = script[index++];
    if (item instanceof Error) throw item;
    return item ?? "ended";
  });
  const startPolling = vi.fn();
  const log = vi.fn();
  await superviseWatch({ follow, startPolling, log, now: () => 0 });
  expect(follow).toHaveBeenCalledTimes(calls);
  expect(startPolling).toHaveBeenCalledTimes(1);
  expect(log.mock.calls.at(-1)?.[0]).toContain(script.at(-1) instanceof Error ? (script.at(-1) as Error).message : script.at(-1));
});

it.each([0, 12_000, 13_000])("bounds restarts in a rolling inclusive minute (%i ms spacing)", async (spacing) => {
  let calls = 0;
  let now = 0;
  const startPolling = vi.fn();
  const log = vi.fn();
  await superviseWatch({
    follow: async () => { now = calls++ * spacing; return calls <= 6 ? marker : "ended"; },
    now: () => now, startPolling, log,
  });
  expect(calls).toBe(spacing === 13_000 ? 7 : 6);
  expect(startPolling).toHaveBeenCalledTimes(1);
  if (spacing !== 13_000) expect(log.mock.calls.at(-1)?.[0]).toBe("restart limit reached; polling");
});

it("awaits pending children without overlap or duplicate polling", async () => {
  let resolve: (value: string) => void = () => {};
  let active = 0;
  let max = 0;
  const follow = vi.fn(() => {
    active++;
    max = Math.max(max, active);
    return new Promise<string>(r => { resolve = value => { active--; r(value); }; });
  });
  const startPolling = vi.fn();
  const done = superviseWatch({ follow, startPolling, log: () => {}, now: () => 0 });
  for (let i = 0; i < 4; i++) {
    expect(follow).toHaveBeenCalledTimes(i + 1);
    expect(startPolling).not.toHaveBeenCalled();
    resolve(marker);
    await Promise.resolve();
  }
  resolve("ended");
  await done;
  await Promise.resolve();
  expect(max).toBe(1);
  expect(follow).toHaveBeenCalledTimes(5);
  expect(startPolling).toHaveBeenCalledTimes(1);
});

it("slides the monotonic window while the replacement remains pending despite wall-clock changes", async () => {
  let calls = 0;
  let monotonic = 0;
  let end: (why: string) => void = () => {};
  const startPolling = vi.fn();
  const follow = vi.fn(async () => {
    calls++;
    if (calls <= 6) { monotonic = (calls - 1) * 13_000; return marker; }
    return new Promise<string>(resolve => { end = resolve; });
  });
  const wallClock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const done = superviseWatch({ follow, startPolling, log: () => {}, now: () => monotonic });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(follow).toHaveBeenCalledTimes(7);
    expect(startPolling).not.toHaveBeenCalled();
    wallClock.mockReturnValue(-1_000_000);
    expect(startPolling).not.toHaveBeenCalled();
    end("ended");
    await done;
    expect(startPolling).toHaveBeenCalledTimes(1);
  } finally { wallClock.mockRestore(); }
});

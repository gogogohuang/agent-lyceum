import { describe, expect, it } from "vitest";
import { cursorQuota, parseCursorUsage, resolveCursorAccessToken } from "../src/quota.js";

describe("parseCursorUsage", () => {
  it("uses totalPercentUsed when present", () => {
    const windows = parseCursorUsage({
      billingCycleStart: "1000000000000",
      billingCycleEnd: "1000604800000", // +7 days
      planUsage: { totalPercentUsed: 25.4, limit: 40000, remaining: 29840 },
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ label: "本週", used_percent: 25.4, remaining_percent: 74.6 });
    expect(windows[0]!.resets).not.toBe("時間不明");
  });

  it("falls back to limit/remaining when totalPercentUsed is missing", () => {
    const windows = parseCursorUsage({
      billingCycleStart: "1000000000000",
      billingCycleEnd: "1002678400000", // +31 days
      planUsage: { limit: 200, remaining: 50 },
    });
    expect(windows[0]).toMatchObject({ label: "本月", used_percent: 75, remaining_percent: 25 });
  });

  it("returns empty when usage cannot be derived", () => {
    expect(parseCursorUsage({})).toEqual([]);
    expect(parseCursorUsage({ planUsage: { limit: 0, remaining: 0 } })).toEqual([]);
    expect(parseCursorUsage({ planUsage: {} })).toEqual([]);
  });

  it("labels other cycle lengths as 計費週期 and missing end as 時間不明", () => {
    expect(parseCursorUsage({
      billingCycleStart: "1000000000000",
      billingCycleEnd: "1000036000000", // +1 hour
      planUsage: { totalPercentUsed: 10 },
    })[0]).toMatchObject({ label: "計費週期" });
    expect(parseCursorUsage({ planUsage: { totalPercentUsed: 10 } })[0]!.resets).toBe("時間不明");
  });
});

describe("resolveCursorAccessToken", () => {
  it("prefers CLI token, then env, then IDE", () => {
    expect(resolveCursorAccessToken({
      readCliToken: () => "cli-token",
      readEnvApiKey: () => "env-key",
      readIdeToken: () => "ide-token",
    })).toBe("cli-token");
    expect(resolveCursorAccessToken({
      readCliToken: () => undefined,
      readEnvApiKey: () => "env-key",
      readIdeToken: () => "ide-token",
    })).toBe("env-key");
    expect(resolveCursorAccessToken({
      readCliToken: () => undefined,
      readEnvApiKey: () => undefined,
      readIdeToken: () => "ide-token",
    })).toBe("ide-token");
    expect(resolveCursorAccessToken({
      readCliToken: () => undefined,
      readEnvApiKey: () => undefined,
      readIdeToken: () => undefined,
    })).toBeUndefined();
  });

  it("ignores blank strings", () => {
    expect(resolveCursorAccessToken({
      readCliToken: () => "  ",
      readEnvApiKey: () => "",
      readIdeToken: () => " ide ",
    })).toBe("ide");
  });
});

describe("cursorQuota", () => {
  it("returns an error report when no token is available", async () => {
    const report = await cursorQuota(undefined, {
      resolveToken: () => undefined,
      fetchUsage: async () => {
        throw new Error("should not fetch");
      },
    });
    expect(report).toMatchObject({ runtime: "cursor", windows: [] });
    expect(report.error).toMatch(/未登入|token|CURSOR_API_KEY|agent login/i);
  });

  it("maps a successful API payload into windows", async () => {
    const report = await cursorQuota(undefined, {
      resolveToken: () => "tok",
      fetchUsage: async () => ({
        billingCycleEnd: String(Date.UTC(2026, 10, 25, 12, 0, 0)),
        billingCycleStart: String(Date.UTC(2026, 10, 18, 12, 0, 0)),
        planUsage: { totalPercentUsed: 40 },
      }),
    });
    expect(report.error).toBeUndefined();
    expect(report.runtime).toBe("cursor");
    expect(report.windows[0]).toMatchObject({ label: "本週", used_percent: 40, remaining_percent: 60 });
  });

  it("returns an error report when the API fails", async () => {
    const report = await cursorQuota(undefined, {
      resolveToken: () => "tok",
      fetchUsage: async () => {
        throw new Error("HTTP 401");
      },
    });
    expect(report).toMatchObject({ runtime: "cursor", windows: [], error: "HTTP 401" });
  });

  it("returns an error when the payload has no usable windows", async () => {
    const report = await cursorQuota(undefined, {
      resolveToken: () => "tok",
      fetchUsage: async () => ({}),
    });
    expect(report.error).toMatch(/沒有回傳額度/);
  });

  it("rethrows AbortError", async () => {
    await expect(
      cursorQuota(undefined, {
        resolveToken: () => "tok",
        fetchUsage: async () => {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("turns a caller abort into AbortError without poisoning sibling quotas", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      cursorQuota(controller.signal, {
        resolveToken: () => "tok",
        fetchUsage: async (_token, signal) => {
          signal?.throwIfAborted();
          return {};
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

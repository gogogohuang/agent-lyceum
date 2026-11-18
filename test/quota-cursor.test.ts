import { afterEach, describe, expect, it, vi } from "vitest";
import { cursorAccessTokens, cursorApiBase, cursorQuota, fetchCursorPeriodUsage, parseCursorUsage } from "../src/quota.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function* yieldTokens(...tokens: string[]): AsyncGenerator<string> {
  yield* tokens;
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const t of it) out.push(t);
  return out;
}

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

  it("clamps limit/remaining outside 0–100 (bonus credit, overage)", () => {
    expect(parseCursorUsage({ planUsage: { limit: 2000, remaining: 2500 } })[0]).toMatchObject({ used_percent: 0, remaining_percent: 100 });
    expect(parseCursorUsage({ planUsage: { limit: 100, remaining: -20 } })[0]).toMatchObject({ used_percent: 100, remaining_percent: 0 });
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

describe("cursorAccessTokens", () => {
  it("yields CLI token, then env, then IDE, skipping blanks and duplicates", async () => {
    expect(await collect(cursorAccessTokens({
      readCliToken: async () => "cli-token",
      readEnvApiKey: () => " env-key ",
      readIdeToken: async () => "cli-token",
    }))).toEqual(["cli-token", "env-key"]);
    expect(await collect(cursorAccessTokens({
      readCliToken: async () => "  ",
      readEnvApiKey: () => "",
      readIdeToken: async () => " ide ",
    }))).toEqual(["ide"]);
  });

  it("does not read the IDE token when an earlier one is enough", async () => {
    let ideReads = 0;
    for await (const _ of cursorAccessTokens({
      readCliToken: async () => "cli",
      readEnvApiKey: () => undefined,
      readIdeToken: async () => {
        ideReads++;
        return "ide";
      },
    })) break;
    expect(ideReads).toBe(0);
  });
});

describe("cursorApiBase", () => {
  it("only honours https *.cursor.sh endpoints", () => {
    expect(cursorApiBase({})).toBe("https://api2.cursor.sh");
    expect(cursorApiBase({ CURSOR_API_ENDPOINT: "https://api3.cursor.sh/" })).toBe("https://api3.cursor.sh");
    expect(cursorApiBase({ CURSOR_API_ENDPOINT: "https://evil.example.com" })).toBe("https://api2.cursor.sh");
    expect(cursorApiBase({ CURSOR_API_ENDPOINT: "http://api3.cursor.sh" })).toBe("https://api2.cursor.sh");
    expect(cursorApiBase({ CURSOR_API_ENDPOINT: "https://cursor.sh.evil.com" })).toBe("https://api2.cursor.sh");
  });
});

describe("cursorQuota", () => {
  it("returns an error report when no token is available", async () => {
    const report = await cursorQuota(undefined, {
      tokens: () => yieldTokens(),
      fetchUsage: async () => {
        throw new Error("should not fetch");
      },
    });
    expect(report).toMatchObject({ runtime: "cursor", windows: [] });
    expect(report.error).toMatch(/未登入|token|CURSOR_API_KEY|agent login/i);
  });

  it("maps a successful API payload into windows", async () => {
    const report = await cursorQuota(undefined, {
      tokens: () => yieldTokens("tok"),
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
      tokens: () => yieldTokens("tok"),
      fetchUsage: async () => {
        throw new Error("HTTP 401");
      },
    });
    expect(report).toMatchObject({ runtime: "cursor", windows: [], error: "HTTP 401" });
  });

  it("returns an error when the payload has no usable windows", async () => {
    const report = await cursorQuota(undefined, {
      tokens: () => yieldTokens("tok"),
      fetchUsage: async () => ({}),
    });
    expect(report.error).toMatch(/沒有回傳額度/);
  });

  it("rethrows AbortError", async () => {
    await expect(
      cursorQuota(undefined, {
        tokens: () => yieldTokens("tok"),
        fetchUsage: async () => {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("falls back to the next token when the API rejects one, and says so when all are rejected", async () => {
    const tried: string[] = [];
    const reject401 = async (token: string) => {
      tried.push(token);
      if (token === "stale") {
        await fetchViaStub(401);
      }
      return { planUsage: { totalPercentUsed: 10 } };
    };
    const report = await cursorQuota(undefined, { tokens: () => yieldTokens("stale", "fresh"), fetchUsage: reject401 });
    expect(tried).toEqual(["stale", "fresh"]);
    expect(report.windows[0]).toMatchObject({ used_percent: 10 });

    const allBad = await cursorQuota(undefined, { tokens: () => yieldTokens("stale"), fetchUsage: reject401 });
    expect(allBad.error).toMatch(/HTTP 401.*agent login/);
  });
});

/** Run the real fetchCursorPeriodUsage against a stubbed global fetch answering `status`. */
async function fetchViaStub(status: number): Promise<unknown> {
  vi.stubGlobal("fetch", async () => new Response("{}", { status }));
  return fetchCursorPeriodUsage("tok");
}

describe("fetchCursorPeriodUsage", () => {
  /** A fetch that never answers until its signal aborts, like a hung server. */
  const hangingFetch = (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });

  it("turns a caller abort into AbortError, so the hub discards the read", async () => {
    vi.stubGlobal("fetch", hangingFetch);
    const controller = new AbortController();
    const pending = fetchCursorPeriodUsage("tok", controller.signal, 10_000);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("turns its own timeout into a plain Error that cursorQuota reports", async () => {
    vi.stubGlobal("fetch", hangingFetch);
    const err = await fetchCursorPeriodUsage("tok", new AbortController().signal, 10).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe("AbortError");
    expect((err as Error).message).toMatch(/沒有回應/);
    const report = await cursorQuota(undefined, { tokens: () => yieldTokens("tok"), fetchUsage: (t, s) => fetchCursorPeriodUsage(t, s, 10) });
    expect(report.error).toMatch(/沒有回應/);
  });

  it("sends the token as a Bearer header and returns the JSON body", async () => {
    let auth: string | null = null;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ planUsage: { totalPercentUsed: 5 } }), { status: 200 });
    });
    await expect(fetchCursorPeriodUsage("tok")).resolves.toEqual({ planUsage: { totalPercentUsed: 5 } });
    expect(auth).toBe("Bearer tok");
  });

  it("reports other HTTP errors as plain errors", async () => {
    await expect(fetchViaStub(500)).rejects.toThrow("HTTP 500");
  });
});

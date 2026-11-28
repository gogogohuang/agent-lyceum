import { EventEmitter } from "node:events";
import type http from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebServer, type StartWebOptions } from "../web/src/start.js";

// No real listen: `listen` is injected, so these run inside a sandbox that rejects sockets.
type Handler = http.RequestListener;

function fakeListen(port = 8787) {
  const state: { handler?: Handler; closed: number } = { closed: 0 };
  const server = {
    address: () => ({ port, address: "127.0.0.1", family: "IPv4" }),
    close: (cb?: (err?: Error) => void) => {
      state.closed += 1;
      cb?.();
    },
  };
  const listen: NonNullable<StartWebOptions["listen"]> = async (_port, _host, handler) => {
    state.handler = handler;
    return { server: server as unknown as http.Server, sockets: new Set<Socket>() };
  };
  return { state, listen };
}

function openEvents(handler: Handler) {
  const req = new EventEmitter();
  const res = new EventEmitter();
  Object.assign(req, { url: "/events", method: "GET", headers: { host: "127.0.0.1:8787" } });
  Object.assign(res, {
    writeHead() {},
    write() {
      return true;
    },
    end() {},
  });
  handler(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
  return { close: () => req.emit("close") };
}

function request(handler: Handler, method: string, url: string, headers: Record<string, string> = {}) {
  const out: { status?: number; body: string; headers?: Record<string, unknown> } = { body: "" };
  const done = new Promise<void>((resolve) => {
    const res = {
      headersSent: false,
      writeHead(status: number, h?: Record<string, unknown>) {
        out.status = status;
        out.headers = h;
      },
      end(chunk?: string) {
        out.body += chunk ?? "";
        resolve();
      },
      write() {},
      on() {},
    };
    handler({ url, method, headers, on() {} } as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
  });
  return { out, done };
}

function opts(over: Partial<StartWebOptions> = {}): StartWebOptions {
  return {
    port: 8787,
    host: "127.0.0.1",
    open: false,
    staticDir: "/nonexistent",
    factory: { list: () => [], watch: vi.fn() },
    ...over,
  };
}

afterEach(() => vi.useRealTimers());

describe("startWebServer binds first", () => {
  it("a listen failure starts nothing: no watch, no quota, no timers", async () => {
    vi.useFakeTimers();
    const quota = vi.fn(async () => []);
    const watch = vi.fn();
    const failing: StartWebOptions["listen"] = async () => {
      throw new Error("Port 8787 is already in use.");
    };
    await expect(startWebServer(opts({ listen: failing, factory: { list: () => ["a"], watch, quota } }))).rejects.toThrow("already in use");
    expect(quota).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a throwing quota reader does not stop the server: nothing asks until a page subscribes", async () => {
    vi.useFakeTimers();
    const { state, listen } = fakeListen();
    const close = vi.fn();
    const watch = vi.fn(() => ({ beat() {}, close }));
    const quota = vi.fn((): Promise<never[]> => {
      throw new Error("quota boom");
    });
    const page = await startWebServer(opts({ listen, factory: { list: () => ["a"], watch, quota } }));
    expect(quota).not.toHaveBeenCalled();
    const events = openEvents(state.handler as Handler);
    expect(quota).toHaveBeenCalledTimes(1);
    events.close();
    await page.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close() aborts the quota request that a subscriber started", async () => {
    const { state, listen } = fakeListen();
    let seen: AbortSignal | undefined;
    const quota = vi.fn((signal?: AbortSignal) => {
      seen = signal;
      return new Promise<never[]>(() => {});
    });
    const page = await startWebServer(opts({ listen, factory: { list: () => [], watch: vi.fn(), quota } }));
    expect(quota).not.toHaveBeenCalled();
    const events = openEvents(state.handler as Handler);
    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(false);
    events.close();
    await page.close();
    expect(seen?.aborted).toBe(true);
  });
});

describe("startWebServer routes", () => {
  async function start(over: Partial<StartWebOptions> = {}) {
    const { state, listen } = fakeListen(8787);
    const page = await startWebServer(opts({ listen, identity: { version: "9.9.9", home: "/h" }, ...over }));
    return { page, handler: state.handler as Handler };
  }

  it("GET /health returns the identity", async () => {
    const { page, handler } = await start();
    const r = request(handler, "GET", "/health", { host: "127.0.0.1:8787" });
    await r.done;
    expect(r.out.status).toBe(200);
    expect(String(r.out.headers?.["Content-Type"])).toContain("application/json");
    const body = JSON.parse(r.out.body);
    expect(Object.keys(body).sort()).toEqual(["app", "home", "pid", "ppid", "started_at", "version"]);
    expect(body).toMatchObject({ app: "agent-lyceum-web", version: "9.9.9", home: "/h", pid: process.pid, ppid: process.ppid });
    expect(Number.isNaN(Date.parse(body.started_at))).toBe(false);
    await page.close();
  });

  it("rejects a foreign Host with 403 and a missing Host with 400, even on /health", async () => {
    const { page, handler } = await start();
    const a = request(handler, "GET", "/health", { host: "evil.example" });
    await a.done;
    expect(a.out.status).toBe(403);
    const b = request(handler, "GET", "/health", {});
    await b.done;
    expect(b.out.status).toBe(400);
    await page.close();
  });

  it("POST /quota: foreign Origin 403 and quota not refreshed; allowed Origin passes", async () => {
    const quota = vi.fn(async () => []);
    const { page, handler } = await start({ factory: { list: () => [], watch: vi.fn(), quota } });
    const calls = quota.mock.calls.length; // the start-up refresh
    const bad = request(handler, "POST", "/quota", { host: "127.0.0.1:8787", origin: "http://evil.example" });
    await bad.done;
    expect(bad.out.status).toBe(403);
    expect(quota.mock.calls.length).toBe(calls);
    const nul = request(handler, "POST", "/quota", { host: "127.0.0.1:8787", origin: "null" });
    await nul.done;
    expect(nul.out.status).toBe(403);
    const ok = request(handler, "POST", "/quota", { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" });
    await ok.done;
    expect(ok.out.status).toBe(200);
    expect(quota.mock.calls.length).toBe(calls + 1);
    await page.close();
  });

  it("allowHosts lets a custom name through; a non-loopback bind skips the check", async () => {
    const a = await start({ allowHosts: ["mybox.local"] });
    const r = request(a.handler, "GET", "/health", { host: "mybox.local:8787" });
    await r.done;
    expect(r.out.status).toBe(200);
    await a.page.close();
    const b = await start({ host: "0.0.0.0" });
    const s = request(b.handler, "GET", "/health", { host: "anything" });
    await s.done;
    expect(s.out.status).toBe(200);
    await b.page.close();
  });

  it("GET /snapshot returns each watched project's current frame", async () => {
    const { page, handler } = await start({
      factory: {
        list: () => ["beta", "alpha"],
        watch: (name, onFrame) => {
          onFrame({ schema_version: 1, report: { project: { name, dir: `/repo/${name}`, lead: "lead" }, agents: [] } });
          return { beat() {}, close() {} };
        },
      },
    });
    const r = request(handler, "GET", "/snapshot", { host: "127.0.0.1:8787" });
    await r.done;
    expect(r.out.status).toBe(200);
    expect(String(r.out.headers?.["Content-Type"])).toContain("application/json");
    expect(JSON.parse(r.out.body)).toEqual({
      projects: [
        { name: "alpha", frame: { schema_version: 1, report: { project: { name: "alpha", dir: "/repo/alpha", lead: "lead" }, agents: [] } } },
        { name: "beta", frame: { schema_version: 1, report: { project: { name: "beta", dir: "/repo/beta", lead: "lead" }, agents: [] } } },
      ],
    });
    await page.close();
  });

  it("the URL shows the real port", async () => {
    const { state, listen } = fakeListen(5555);
    const page = await startWebServer(opts({ listen, port: 0 }));
    expect(page.url).toBe("http://127.0.0.1:5555/");
    expect(state.handler).toBeDefined();
    await page.close();
  });
});

const QUOTA_INTERVAL_MS = 5 * 60_000;

describe("quota refresh follows subscribers", () => {
  it("does not ask without a subscriber, including startup, the heartbeat and GET /snapshot", async () => {
    vi.useFakeTimers();
    const { state, listen } = fakeListen();
    const beat = vi.fn();
    const quota = vi.fn(async () => []);
    const page = await startWebServer(
      opts({
        listen,
        heartbeatMs: 5_000,
        factory: { list: () => ["a"], watch: () => ({ beat, close() {} }), quota },
      }),
    );
    expect(quota).not.toHaveBeenCalled();
    const beats = beat.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(beat.mock.calls.length).toBeGreaterThan(beats);
    expect(quota).not.toHaveBeenCalled();
    const snap = request(state.handler as Handler, "GET", "/snapshot", { host: "127.0.0.1:8787" });
    await snap.done;
    expect(snap.out.status).toBe(200);
    expect(quota).not.toHaveBeenCalled();
    await page.close();
  });

  it("refreshes once on the first subscribe, not again on a resubscribe inside the interval, and POST /quota still refreshes", async () => {
    vi.useFakeTimers();
    const { state, listen } = fakeListen();
    const quota = vi.fn(async () => [{ runtime: "claude" as const, windows: [] }]);
    const page = await startWebServer(opts({ listen, factory: { list: () => [], watch: vi.fn(), quota } }));
    const handler = state.handler as Handler;
    const first = openEvents(handler);
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(1));
    first.close();
    vi.advanceTimersByTime(60_000);
    const second = openEvents(handler);
    expect(quota).toHaveBeenCalledTimes(1);
    const post = request(handler, "POST", "/quota", { host: "127.0.0.1:8787" });
    await post.done;
    expect(post.out.status).toBe(200);
    expect(quota).toHaveBeenCalledTimes(2);
    second.close();
    await page.close();
  });

  it("does not start a second automatic refresh while one is in flight, then refreshes again after five minutes", async () => {
    vi.useFakeTimers();
    const { state, listen } = fakeListen();
    let resolveQuota: (reports: []) => void = () => {};
    const quota = vi.fn(() => new Promise<[]>((resolve) => (resolveQuota = resolve)));
    const page = await startWebServer(opts({ listen, factory: { list: () => [], watch: vi.fn(), quota } }));
    const events = openEvents(state.handler as Handler);
    expect(quota).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUOTA_INTERVAL_MS);
    expect(quota).toHaveBeenCalledTimes(1);
    resolveQuota([]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(QUOTA_INTERVAL_MS);
    expect(quota).toHaveBeenCalledTimes(2);
    events.close();
    await page.close();
  });

  it("refreshes on the five-minute beat when the previous read finished after that beat was armed", async () => {
    vi.useFakeTimers();
    const { state, listen } = fakeListen();
    const quota = vi.fn(() => new Promise<[]>((resolve) => setTimeout(() => resolve([]), 2_000)));
    const page = await startWebServer(opts({ listen, factory: { list: () => [], watch: vi.fn(), quota } }));
    const events = openEvents(state.handler as Handler);
    expect(quota).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(QUOTA_INTERVAL_MS - 2_000);
    expect(quota).toHaveBeenCalledTimes(2);
    events.close();
    await page.close();
  });

  it("reads when the cached quota expires, not a full interval after a late subscribe", async () => {
    vi.useFakeTimers();
    const { state, listen } = fakeListen();
    const quota = vi.fn(async () => [{ runtime: "claude" as const, windows: [] }]);
    const page = await startWebServer(opts({ listen, factory: { list: () => [], watch: vi.fn(), quota } }));
    const handler = state.handler as Handler;
    const first = openEvents(handler);
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);
    first.close();
    await vi.advanceTimersByTimeAsync(QUOTA_INTERVAL_MS - 1_000);
    const second = openEvents(handler);
    expect(quota).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(quota).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(quota).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(QUOTA_INTERVAL_MS);
    expect(quota).toHaveBeenCalledTimes(3);
    second.close();
    await page.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a disconnect that leaves a subscriber does not read or move the next beat", async () => {
    vi.useFakeTimers();
    const { state, listen } = fakeListen();
    const quota = vi.fn(async () => {
      throw new Error("quota boom");
    });
    const page = await startWebServer(opts({ listen, factory: { list: () => [], watch: vi.fn(), quota } }));
    const handler = state.handler as Handler;
    const kept = openEvents(handler);
    const leaving = openEvents(handler);
    expect(quota).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quota).toHaveBeenCalledTimes(1);
    leaving.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(quota).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUOTA_INTERVAL_MS - 60_000 - 1_000);
    expect(quota).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(quota).toHaveBeenCalledTimes(2);
    kept.close();
    await page.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("later pages joining after a failed read do not read again; the next attempt is the five-minute beat", async () => {
    vi.useFakeTimers();
    const { state, listen } = fakeListen();
    const quota = vi.fn(async () => {
      throw new Error("quota boom");
    });
    const page = await startWebServer(opts({ listen, factory: { list: () => [], watch: vi.fn(), quota } }));
    const handler = state.handler as Handler;
    const open = [openEvents(handler)];
    await vi.advanceTimersByTimeAsync(0);
    expect(quota).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) {
      open.push(openEvents(handler));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(quota).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUOTA_INTERVAL_MS - 1_000);
    expect(quota).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(quota).toHaveBeenCalledTimes(2);
    for (const events of open) events.close();
    await page.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed read on the five-minute beat, and a manual refresh does not push that beat past five minutes", async () => {
    vi.useFakeTimers();
    const { state, listen } = fakeListen();
    let fail = true;
    const quota = vi.fn(async () => {
      if (fail) throw new Error("quota boom");
      return [{ runtime: "claude" as const, windows: [] }];
    });
    const page = await startWebServer(opts({ listen, factory: { list: () => [], watch: vi.fn(), quota } }));
    const handler = state.handler as Handler;
    const events = openEvents(handler);
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);
    fail = false;
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(quota).toHaveBeenCalledTimes(1);
    const post = request(handler, "POST", "/quota", { host: "127.0.0.1:8787" });
    await post.done;
    expect(post.out.status).toBe(200);
    expect(quota).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(QUOTA_INTERVAL_MS);
    expect(quota.mock.calls.length).toBeGreaterThanOrEqual(3);
    events.close();
    await page.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

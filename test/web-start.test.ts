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

  it("a failure after bind rolls back: server closed, hub closed, no timers", async () => {
    vi.useFakeTimers();
    const { state, listen } = fakeListen();
    const close = vi.fn();
    const watch = vi.fn(() => ({ beat() {}, close }));
    const quota = vi.fn((): Promise<never[]> => {
      throw new Error("quota boom");
    });
    await expect(startWebServer(opts({ listen, factory: { list: () => ["a"], watch, quota } }))).rejects.toThrow("quota boom");
    expect(state.closed).toBe(1);
    expect(close).toHaveBeenCalledTimes(1); // the project watch started before the failure was closed
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close() aborts the quota request that is in flight", async () => {
    const { listen } = fakeListen();
    let seen: AbortSignal | undefined;
    const quota = vi.fn((signal?: AbortSignal) => {
      seen = signal;
      return new Promise<never[]>(() => {});
    });
    const page = await startWebServer(opts({ listen, factory: { list: () => [], watch: vi.fn(), quota } }));
    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(false);
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

  it("the URL shows the real port", async () => {
    const { state, listen } = fakeListen(5555);
    const page = await startWebServer(opts({ listen, port: 0 }));
    expect(page.url).toBe("http://127.0.0.1:5555/");
    expect(state.handler).toBeDefined();
    await page.close();
  });
});

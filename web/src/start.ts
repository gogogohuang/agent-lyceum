import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { Socket } from "node:net";
import type { WatchFactory } from "./server/hub.js";
import { createWebHub } from "./server/hub.js";
import { handleApi, type ConsoleDeps } from "./server/api.js";
import { checkRequest, isLoopbackHost } from "./server/guard.js";
import { attachEvents, listen as listenHttp, serveStatic } from "./server/http.js";
import { openBrowser } from "./server/open.js";
import { handleSummary } from "./server/summary.js";

export type WebIdentity = { version: string; home: string };

export type StartWebOptions = {
  port: number;
  host: string;
  open: boolean;
  staticDir: string;
  factory: WatchFactory;
  heartbeatMs?: number;
  /** Reported by `GET /health` so another process can tell this server from a foreign one. */
  identity?: WebIdentity;
  /** Extra Host names accepted while bound to a loopback address (`--allow-host`). */
  allowHosts?: string[];
  /** The command console (the write API). Without it `/api/*` is 404. */
  console?: ConsoleDeps;
  /** Replaceable so tests can run without a socket. */
  listen?: (port: number, host: string, onRequest: http.RequestListener) => Promise<{ server: http.Server; sockets: Set<Socket> }>;
};

/** A repeated header arrives as an array; it is never valid for Origin or the token, so it becomes "" (the guard refuses an empty value). */
const singleHeader = (v: string | string[] | undefined) => (Array.isArray(v) ? "" : v);

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

/** Binds first; the hub, the quota reads and the timers start only once the port is ours, and are undone if that fails. */
export async function startWebServer(opts: StartWebOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const hub = createWebHub(opts.factory);
  const startedAt = new Date().toISOString();
  let boundPort = opts.port;
  const token = randomBytes(24).toString("hex");
  const { server, sockets } = await (opts.listen ?? listenHttp)(opts.port, opts.host, (req, res) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    const rejected = checkRequest(
      {
        method: req.method,
        pathname,
        host: req.headers.host,
        origin: singleHeader(req.headers.origin),
        token: singleHeader(req.headers["x-lyceum-token"]),
      },
      { bindHost: opts.host, allowHosts: opts.allowHosts ?? [], port: boundPort, token },
    );
    if (rejected) {
      res.writeHead(rejected);
      res.end();
      return;
    }
    if (pathname === "/health" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, JSON_HEADERS);
      res.end(
        JSON.stringify({
          app: "agent-lyceum-web",
          version: opts.identity?.version ?? "unknown",
          pid: process.pid,
          ppid: process.ppid,
          home: opts.identity?.home ?? "",
          started_at: startedAt,
        }),
      );
      return;
    }
    if (pathname === "/events") {
      attachEvents(hub, req, res);
      return;
    }
    if (pathname === "/summary" && req.method === "POST") {
      void handleSummary(req, res, hub, opts.factory.summarize).catch(() => {
        if (res.headersSent) return;
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ error: "沒有寫出摘要。" }));
      });
      return;
    }
    if (pathname === "/quota" && req.method === "POST") {
      void hub.refreshQuota().then(
        (reports) => {
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify(reports ?? []));
        },
        () => {
          if (res.headersSent) return;
          res.writeHead(500);
          res.end();
        },
      );
      return;
    }
    // Same raw pathname the guard saw: `//api/x`, `/%61pi/x` and `/api` never match, so they cannot reach handleApi.
    if (pathname.startsWith("/api/")) {
      if (!opts.console) {
        res.writeHead(404, JSON_HEADERS);
        res.end(JSON.stringify({ error: "沒有這個 API。" }));
        return;
      }
      if (!isLoopbackHost(opts.host)) {
        res.writeHead(403, JSON_HEADERS);
        res.end(JSON.stringify({ error: "指令控制台只限本機使用，不能在非 loopback 的 --host 上開放。" }));
        return;
      }
      const fail = (status: number, error: string) => {
        if (res.headersSent) return;
        res.writeHead(status, JSON_HEADERS);
        res.end(JSON.stringify({ error }));
      };
      // handleApi sees the normalized URL: `/api/../health` passes the raw test above but is not an API path.
      void handleApi(req, res, new URL(`http://127.0.0.1${req.url ?? "/"}`), opts.console).then(
        (handled) => {
          if (!handled) fail(404, "沒有這個 API。");
        },
        () => fail(500, "伺服器出錯。"),
      );
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    serveStatic(opts.staticDir, req, res, token);
  });
  const address = server.address();
  boundPort = typeof address === "object" && address ? address.port : opts.port;

  let heartbeat: NodeJS.Timeout | undefined;
  let quotaBeat: NodeJS.Timeout | undefined;
  const close = () =>
    new Promise<void>((resolve, reject) => {
      clearInterval(heartbeat);
      clearInterval(quotaBeat);
      hub.close();
      for (const socket of sockets) socket.destroy();
      server.close((err) => {
        if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(err);
        else resolve();
      });
    });

  const host = opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host;
  const shown = host.includes(":") ? `[${host}]` : host;
  const url = `http://${shown}:${boundPort}/`;
  try {
    hub.start();
    void hub.refreshQuota();
    heartbeat = setInterval(() => hub.beat(), opts.heartbeatMs ?? 5_000);
    quotaBeat = setInterval(() => void hub.refreshQuota(), 60_000);
    if (opts.open) openBrowser(url);
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return { url, close };
}

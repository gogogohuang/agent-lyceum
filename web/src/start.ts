import type http from "node:http";
import type { Socket } from "node:net";
import type { WatchFactory } from "./server/hub.js";
import { createWebHub } from "./server/hub.js";
import { checkRequest } from "./server/guard.js";
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
  /** Replaceable so tests can run without a socket. */
  listen?: (port: number, host: string, onRequest: http.RequestListener) => Promise<{ server: http.Server; sockets: Set<Socket> }>;
};

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

/** Binds first; the hub, the quota reads and the timers start only once the port is ours, and are undone if that fails. */
export async function startWebServer(opts: StartWebOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const hub = createWebHub(opts.factory);
  const startedAt = new Date().toISOString();
  let boundPort = opts.port;
  const { server, sockets } = await (opts.listen ?? listenHttp)(opts.port, opts.host, (req, res) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    const origin = req.headers.origin;
    const rejected = checkRequest(
      { method: req.method, pathname, host: req.headers.host, origin: Array.isArray(origin) ? origin[0] : origin },
      { bindHost: opts.host, allowHosts: opts.allowHosts ?? [], port: boundPort },
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
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    serveStatic(opts.staticDir, req, res);
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

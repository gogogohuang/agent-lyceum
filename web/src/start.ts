import type { WatchFactory } from "./server/hub.js";
import { createWebHub } from "./server/hub.js";
import { attachEvents, listen, serveStatic } from "./server/http.js";
import { openBrowser } from "./server/open.js";

export type StartWebOptions = {
  port: number;
  host: string;
  open: boolean;
  staticDir: string;
  factory: WatchFactory;
  heartbeatMs?: number;
};

export async function startWebServer(opts: StartWebOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const hub = createWebHub(opts.factory);
  hub.start();
  hub.refreshQuota();
  const heartbeat = setInterval(() => hub.beat(), opts.heartbeatMs ?? 5_000);
  const quotaBeat = setInterval(() => hub.refreshQuota(), 60_000);
  const { server, sockets } = await listen(opts.port, opts.host, (req, res) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    if (pathname === "/events") {
      attachEvents(hub, req, res);
      return;
    }
    if (pathname === "/quota" && req.method === "POST") {
      void hub.refreshQuota().then(
        (reports) => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
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
  const port = typeof address === "object" && address ? address.port : opts.port;
  const host = opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host;
  const shown = host.includes(":") ? `[${host}]` : host;
  const url = `http://${shown}:${port}/`;
  if (opts.open) openBrowser(url);
  return {
    url,
    close: () =>
      new Promise((resolve, reject) => {
        clearInterval(heartbeat);
        clearInterval(quotaBeat);
        hub.close();
        for (const socket of sockets) socket.destroy();
        server.close((err) => {
          if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(err);
          else resolve();
        });
      }),
  };
}

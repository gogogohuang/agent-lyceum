import fs from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import type { WebEvent } from "../types.js";
import type { WebHub } from "./hub.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function sendFile(res: http.ServerResponse, file: string): void {
  const ext = path.extname(file);
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
  fs.createReadStream(file).pipe(res);
}

export function serveStatic(staticDir: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const root = path.resolve(staticDir);
  let pathname = "/";
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const requested = path.resolve(root, `.${pathname}`);
  if (!inside(root, requested)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (fs.existsSync(requested) && fs.statSync(requested).isFile()) {
    sendFile(res, requested);
    return;
  }
  const ext = path.extname(pathname);
  const index = path.join(root, "index.html");
  if ((ext && ext !== ".html") || !fs.existsSync(index)) {
    res.writeHead(404);
    res.end();
    return;
  }
  sendFile(res, index);
}

export function writeEvent(res: http.ServerResponse, event: WebEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function attachEvents(hub: WebHub, req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const unsubscribe = hub.subscribe((event) => writeEvent(res, event));
  const ping = setInterval(() => {
    res.write(": ping\n\n");
  }, 15_000);
  const done = () => {
    clearInterval(ping);
    unsubscribe();
  };
  req.on("close", done);
  res.on("error", done);
}

export function listen(port: number, host: string, onRequest: http.RequestListener): Promise<{ server: http.Server; sockets: Set<Socket> }> {
  const server = http.createServer(onRequest);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    const fail = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") reject(new Error(`Port ${port} is already in use.`));
      else reject(err);
    };
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      resolve({ server, sockets });
    });
  });
}

import fs from "node:fs";
import type http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWebServer, type StartWebOptions } from "../web/src/start.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-start-"));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public", "index.html"), '<html><head><meta name="lyceum-token" content="__LYCEUM_TOKEN__" /></head></html>');
  fs.writeFileSync(path.join(root, "fake-cli.mjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function boot(over: Partial<StartWebOptions> = {}) {
  const state: { handler?: http.RequestListener } = {};
  const server = { address: () => ({ port: 8787, address: "127.0.0.1", family: "IPv4" }), close: (cb?: () => void) => cb?.() };
  const listen: NonNullable<StartWebOptions["listen"]> = async (_p, _h, handler) => {
    state.handler = handler;
    return { server: server as unknown as http.Server, sockets: new Set<Socket>() };
  };
  const opts: StartWebOptions = {
    port: 8787,
    host: "127.0.0.1",
    open: false,
    staticDir: path.join(root, "public"),
    factory: { list: () => [], watch: vi.fn() },
    console: {
      home: path.join(root, "home"),
      cli: { execPath: process.execPath, args: [path.join(root, "fake-cli.mjs")] },
      projectDir: () => undefined,
      readAsk: () => undefined,
      saveAnswers: () => ({ complete: true, problems: [] }),
    },
    listen,
    ...over,
  };
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  return { opts, state };
}

function request(handler: http.RequestListener, method: string, url: string, headers: Record<string, string> = {}, body?: unknown) {
  const out: { status?: number; body: string } = { body: "" };
  const done = new Promise<void>((resolve) => {
    const res = {
      headersSent: false,
      writeHead(status: number) {
        out.status = status;
        this.headersSent = true;
      },
      end(chunk?: string) {
        out.body += chunk ?? "";
        resolve();
      },
      write() {},
      on() {},
    };
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Object.assign(Readable.from(payload), { method, url, headers });
    handler(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
  });
  return { out, done };
}

const goodHeaders = (token: string) => ({ host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787", "x-lyceum-token": token });

describe("write API through the real handler", () => {
  it("serves index.html with the token and accepts a command that carries it", async () => {
    const { opts, state } = boot();
    const page = await startWebServer(opts);
    try {
      const home = request(state.handler as http.RequestListener, "GET", "/", { host: "127.0.0.1:8787" });
      await home.done;
      const token = /content="([0-9a-f]{48})"/.exec(home.out.body)?.[1];
      expect(token).toBeTruthy();

      const ok = request(state.handler as http.RequestListener, "POST", "/api/cmd/init", goodHeaders(token as string), {});
      await ok.done;
      expect(ok.out.status).toBe(200);
      expect(JSON.parse((JSON.parse(ok.out.body) as { stdout: string }).stdout)).toEqual(["--home", path.join(root, "home"), "init", "-y"]);

      for (const headers of [
        { host: "127.0.0.1:8787", "x-lyceum-token": token as string },
        { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" },
        { ...goodHeaders("0".repeat(48)) },
        { ...goodHeaders(token as string), origin: "http://evil.example" },
      ]) {
        const bad = request(state.handler as http.RequestListener, "POST", "/api/cmd/init", headers, {});
        await bad.done;
        expect(bad.out.status).toBe(403);
      }
    } finally {
      await page.close();
    }
  });

  it("a non-loopback bind refuses the write API even with a valid token", async () => {
    const { opts, state } = boot({ host: "0.0.0.0" });
    const page = await startWebServer(opts);
    try {
      const home = request(state.handler as http.RequestListener, "GET", "/", { host: "x" });
      await home.done;
      const token = /content="([0-9a-f]{48})"/.exec(home.out.body)?.[1] as string;
      const r = request(state.handler as http.RequestListener, "POST", "/api/cmd/init", { host: "x", origin: "http://x", "x-lyceum-token": token }, {});
      await r.done;
      expect(r.out.status).toBe(403);
    } finally {
      await page.close();
    }
  });

  it("without console deps /api is 404", async () => {
    const { opts, state } = boot();
    const { console: _omit, ...rest } = opts;
    const page = await startWebServer(rest);
    try {
      const r = request(state.handler as http.RequestListener, "GET", "/api/jobs", { host: "127.0.0.1:8787" });
      await r.done;
      expect(r.out.status).toBe(404);
    } finally {
      await page.close();
    }
  });
});

describe("the router and the guard agree on /api paths", () => {
  async function tokenOf(state: { handler?: http.RequestListener }) {
    const home = request(state.handler as http.RequestListener, "GET", "/", { host: "127.0.0.1:8787" });
    await home.done;
    return /content="([0-9a-f]{48})"/.exec(home.out.body)?.[1] as string;
  }

  it("never executes a command through odd spellings of /api", async () => {
    const { opts, state } = boot();
    const page = await startWebServer(opts);
    try {
      const token = await tokenOf(state);
      for (const url of ["//api/cmd/init", "/%61pi/cmd/init", "/api", "/API/cmd/init", "/api%2Fcmd/init"]) {
        const r = request(state.handler as http.RequestListener, "POST", url, goodHeaders(token), {});
        await r.done;
        expect(r.out.status).toBe(405);
        expect(r.out.body).not.toContain("stdout");
      }
    } finally {
      await page.close();
    }
  });

  it("refuses array-valued Origin and token headers", async () => {
    const { opts, state } = boot();
    const page = await startWebServer(opts);
    try {
      const token = await tokenOf(state);
      for (const headers of [
        { host: "127.0.0.1:8787", origin: ["http://127.0.0.1:8787"], "x-lyceum-token": token },
        { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787", "x-lyceum-token": [token] },
      ]) {
        const r = request(state.handler as http.RequestListener, "POST", "/api/cmd/init", headers as unknown as Record<string, string>, {});
        await r.done;
        expect(r.out.status).toBe(403);
      }
    } finally {
      await page.close();
    }
  });

  it("uses a different token on every start", async () => {
    const a = boot();
    const pa = await startWebServer(a.opts);
    const b = boot();
    const pb = await startWebServer(b.opts);
    try {
      expect(await tokenOf(a.state)).not.toBe(await tokenOf(b.state));
    } finally {
      await pa.close();
      await pb.close();
    }
  });
});

describe("local-only console and dot-segment paths", () => {
  it("refuses every /api method on a non-loopback bind", async () => {
    const { opts, state } = boot({ host: "0.0.0.0" });
    const page = await startWebServer(opts);
    try {
      for (const [method, url] of [["GET", "/api/jobs"], ["GET", "/api/ask/p/r1"], ["POST", "/api/cmd/init"]]) {
        const r = request(state.handler as http.RequestListener, method as string, url as string, { host: "x" });
        await r.done;
        expect(r.out.status).toBe(403);
        expect(r.out.body).not.toContain("jobs");
      }
    } finally {
      await page.close();
    }
  });

  it("answers 404 (does not hang) for /api/../health", async () => {
    const { opts, state } = boot();
    const page = await startWebServer(opts);
    try {
      const r = request(state.handler as http.RequestListener, "GET", "/api/../health", { host: "127.0.0.1:8787" });
      await Promise.race([r.done, new Promise((_, rej) => setTimeout(() => rej(new Error("hung")), 2000))]);
      expect(r.out.status).toBe(404);
    } finally {
      await page.close();
    }
  });
});

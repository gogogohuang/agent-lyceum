import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./helpers.js";

// Real listen on port 0. CI builds web first; here it is skipped when web is not built, and when the sandbox
// refuses to listen (EPERM/EACCES: "not verified in the sandbox").
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const built = fs.existsSync(path.join(root, "web", "dist", "start.js")) && fs.existsSync(path.join(root, "web", "dist", "public", "index.html"));

let env: TestEnv;
const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) k.kill("SIGKILL");
  env?.cleanup();
});

type Launched = { child: ChildProcess; url: Promise<string | undefined>; stderr: () => string; exited: Promise<{ code: number | null }> };
function launch(extra: string[]): Launched {
  const child = spawn(tsx, [cli, "--home", env.home, "status", "--web", "--no-open", "--exit-with-parent", "--heartbeat", "1", ...extra], { stdio: ["pipe", "pipe", "pipe"] });
  kids.push(child);
  let err = "";
  child.stderr?.on("data", (d) => (err += d));
  const exited = new Promise<{ code: number | null }>((resolve) => child.on("exit", (code) => resolve({ code })));
  const url = new Promise<string | undefined>((resolve) => {
    let buf = "";
    child.stdout?.on("data", (d) => {
      buf += d;
      const line = buf.split("\n")[0];
      if (buf.includes("\n")) resolve(line);
    });
    void exited.then(() => resolve(undefined));
  });
  return { child, url, stderr: () => err, exited };
}
const get = (url: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });

describe.skipIf(!built)("status --web --exit-with-parent (real listen)", { timeout: 60_000 }, () => {
  it("prints the URL first, serves /health, names itself to a second instance, and exits when the reader goes away", async (ctx) => {
    env = makeEnv();
    const a = launch(["--port", "0"]);
    const url = await a.url;
    if (!url) {
      if (/EPERM|EACCES/.test(a.stderr())) return ctx.skip(); // sandbox refuses to listen: not verified here
      throw new Error(`no URL; stderr: ${a.stderr()}`);
    }
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const health = await get(`${url}health`);
    expect(health.status).toBe(200);
    const identity = JSON.parse(health.body) as { pid: number };
    expect(identity).toMatchObject({ app: "agent-lyceum-web", home: env.home });
    expect(identity.pid).toBeGreaterThan(0); // tsx runs the CLI in a child, so this is not a.child.pid
    expect((await get(url, { Host: "evil.example" })).status).toBe(403);

    const port = new URL(url).port;
    const b = launch(["--port", port]);
    const code = await b.exited;
    expect(code.code).toBe(1);
    expect(b.stderr().trim().split("\n")).toEqual([`status --web: port ${port} in use by agent-lyceum-web pid ${identity.pid} home ${env.home}`]);

    a.child.stdout?.destroy(); // the reader goes away
    const ended = await Promise.race([a.exited, new Promise<"alive">((r) => setTimeout(() => r("alive"), 15_000))]);
    expect(ended).not.toBe("alive");
  });
});

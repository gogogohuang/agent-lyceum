import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleApi, type ConsoleDeps } from "../web/src/server/api.js";
import { readJob } from "../web/src/server/runner.js";

let root: string;
let repo: string;
let deps: ConsoleDeps;
const saved: { args?: unknown[] } = {};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-api-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const fake = path.join(root, "fake-cli.mjs");
  fs.writeFileSync(
    fake,
    [
      "const args = process.argv.slice(2);",
      "if (args.includes('FAIL')) process.exit(3);",
      "process.stdout.write(JSON.stringify({ args, cwd: process.cwd() }));",
    ].join("\n"),
  );
  deps = {
    home: path.join(root, "home"),
    cli: { execPath: process.execPath, args: [fake] },
    projectDir: (name) => (name === "web" ? repo : undefined),
    readAsk: (p, r) => (p === "web" && r === "r1" ? { status: "pending", questions: [{ id: "q1", text: "A or B?", asker: "lead", options: ["A", "B"], delivered: false }] } : undefined),
    saveAnswers: (p, r, a, d) => {
      saved.args = [p, r, a, d];
      return { complete: true, problems: [] };
    },
    shortTimeoutMs: 5000,
  };
  fs.mkdirSync(deps.home, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function call(method: string, url: string, body?: unknown, raw?: Buffer) {
  const payload = raw ?? (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
  const req = Object.assign(Readable.from(payload.length ? [payload] : []), { method, url, headers: {} }) as unknown as IncomingMessage;
  const out: { status: number; body: string } = { status: 0, body: "" };
  const res = {
    headersSent: false,
    writeHead(status: number) {
      out.status = status;
      this.headersSent = true;
    },
    end(chunk?: string) {
      out.body += chunk ?? "";
    },
  } as unknown as ServerResponse;
  return handleApi(req, res, new URL(url, "http://127.0.0.1:8787"), deps).then((handled) => ({ handled, status: out.status, json: out.body ? (JSON.parse(out.body) as Record<string, any>) : {} }));
}

describe("POST /api/cmd/:id", () => {
  it("a short command returns its output, run in the project's repo", async () => {
    const r = await call("POST", "/api/cmd/doctor", { project: "web", resolved: true });
    expect(r.status).toBe(200);
    expect(r.json.mode).toBe("short");
    expect(r.json.exit).toBe(0);
    const out = JSON.parse(r.json.stdout as string) as { args: string[]; cwd: string };
    expect(out.args).toEqual(["--home", deps.home, "doctor", "-p", "web", "--resolved"]);
    expect(fs.realpathSync(out.cwd)).toBe(fs.realpathSync(repo));
  });
  it("a detached command answers 202 with a job that finishes", async () => {
    const r = await call("POST", "/api/cmd/run", { project: "web", task: "build it" });
    expect(r.status).toBe(202);
    expect(r.json.mode).toBe("detached");
    const jobsDir = path.join(deps.home, "web-jobs");
    const end = Date.now() + 5000;
    while (readJob(jobsDir, r.json.jobId as string)?.state !== "ended" && Date.now() < end) await new Promise((x) => setTimeout(x, 25));
    expect(readJob(jobsDir, r.json.jobId as string)?.exit).toBe(0);
  });
  it("home-scoped commands run in the home", async () => {
    const r = await call("POST", "/api/cmd/project.list", {});
    expect(fs.realpathSync((JSON.parse(r.json.stdout as string) as { cwd: string }).cwd)).toBe(fs.realpathSync(deps.home));
  });
  it("unknown command 404, unknown project 404", async () => {
    expect((await call("POST", "/api/cmd/nope", {})).status).toBe(404);
    expect((await call("POST", "/api/cmd/__proto__", {})).status).toBe(404);
    expect((await call("POST", "/api/cmd/doctor", { project: "other" })).status).toBe(404);
  });
  it("a bad body is 400 with the field", async () => {
    const r = await call("POST", "/api/cmd/run", { project: "web" });
    expect(r.status).toBe(400);
    expect(r.json.field).toBe("task");
    expect((await call("POST", "/api/cmd/run", undefined, Buffer.from("{not json"))).status).toBe(400);
    expect((await call("POST", "/api/cmd/run", undefined, Buffer.from("[1]"))).status).toBe(400);
  });
  it("a body over 256 KB is 413", async () => {
    const r = await call("POST", "/api/cmd/run", undefined, Buffer.from(JSON.stringify({ project: "web", task: "x".repeat(300 * 1024) })));
    expect(r.status).toBe(413);
  });
  it("confirm tier: 428 until confirm is true", async () => {
    const body = { project: "web", run: "r1" };
    const first = await call("POST", "/api/cmd/clear", body);
    expect(first.status).toBe(428);
    expect(first.json.need).toBe("confirm");
    expect((await call("POST", "/api/cmd/clear", { ...body, confirm: "true" })).status).toBe(428);
    expect((await call("POST", "/api/cmd/clear", { ...body, confirm: true })).status).toBe(200);
  });
  it("a dry run needs no confirmation", async () => {
    expect((await call("POST", "/api/cmd/clear", { project: "web", run: "r1", dryRun: true })).status).toBe(200);
  });
  it("typed tier: 428 with the target until confirmText matches", async () => {
    const body = { name: "web", purge: true };
    const first = await call("POST", "/api/cmd/project.remove", body);
    expect(first.status).toBe(428);
    expect(first.json).toEqual({ need: "typed", target: "web" });
    expect((await call("POST", "/api/cmd/project.remove", { ...body, confirmText: "wrong" })).status).toBe(428);
    expect((await call("POST", "/api/cmd/project.remove", { ...body, confirmText: "web" })).status).toBe(200);
  });
  it("validation comes before the confirmation question", async () => {
    expect((await call("POST", "/api/cmd/clear", { project: "web" })).status).toBe(400);
  });
  it("a failing command is still a 200 with its exit code", async () => {
    const r = await call("POST", "/api/cmd/doctor", { project: "web" });
    expect(r.status).toBe(200);
    const bad = await call("POST", "/api/cmd/clear", { project: "web", run: "FAIL", confirm: true });
    expect(bad.json.exit).toBe(3);
  });
});

describe("jobs", () => {
  it("lists and reads jobs", async () => {
    const started = await call("POST", "/api/cmd/run", { project: "web", task: "t" });
    const list = await call("GET", "/api/jobs");
    expect((list.json.jobs as { id: string }[]).map((j) => j.id)).toContain(started.json.jobId);
    const one = await call("GET", `/api/jobs/${started.json.jobId as string}`);
    expect(one.status).toBe(200);
    expect(one.json.command).toBe("run");
    expect((await call("GET", "/api/jobs/..%2Fx")).status).toBe(404);
  });
});

describe("ask", () => {
  it("reads questions", async () => {
    const r = await call("GET", "/api/ask?project=web&run=r1");
    expect(r.status).toBe(200);
    expect((r.json.questions as { id: string }[])[0]?.id).toBe("q1");
    expect((await call("GET", "/api/ask?project=web&run=nope")).status).toBe(404);
    expect((await call("GET", "/api/ask?project=..&run=r1")).status).toBe(400);
  });
  it("saves answers through the dep", async () => {
    const r = await call("POST", "/api/ask/answers", { project: "web", run: "r1", answers: { q1: "A" }, assumeDefaults: true });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ complete: true, problems: [] });
    expect(saved.args).toEqual(["web", "r1", { q1: "A" }, true]);
    expect((await call("POST", "/api/ask/answers", { project: "web", run: "r1", answers: { q1: 5 } })).status).toBe(400);
  });
});

describe("routing", () => {
  it("only claims /api/ paths", async () => {
    expect((await call("GET", "/events")).handled).toBe(false);
    expect((await call("GET", "/api/zzz")).status).toBe(404);
  });
});

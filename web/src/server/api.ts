import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { ArgError, COMMANDS, type Body, type CommandId } from "../commands.js";
import { listJobs, readJob, runShort, startJob, type CliLauncher } from "./runner.js";

export type AskQuestionView = { id: string; text: string; asker: string; options?: string[]; suggested?: { value: string; reason?: string }; answer?: string; delivered: boolean };
export type AskView = { status: "pending" | "answered"; questions: AskQuestionView[] };

export type ConsoleDeps = {
  home: string;
  cli: CliLauncher;
  /** The repo of a registered project, or undefined when the name is not registered. */
  projectDir: (name: string) => string | undefined;
  readAsk: (project: string, runId: string) => AskView | undefined;
  saveAnswers: (project: string, runId: string, answers: Record<string, string>, assumeDefaults: boolean) => { complete: boolean; problems: string[] };
  shortTimeoutMs?: number;
};

const BODY_LIMIT = 256 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

class BodyTooLarge extends Error {}
class BadBody extends Error {}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        if (!value || typeof value !== "object" || Array.isArray(value)) reject(new BadBody());
        else resolve(value as Body);
      } catch {
        reject(new BadBody());
      }
    });
    req.on("error", fail);
  });
}

async function body(req: IncomingMessage, res: ServerResponse): Promise<Body | undefined> {
  try {
    return await readJson(req);
  } catch (e) {
    if (e instanceof BodyTooLarge) send(res, 413, { error: "請求太大。" });
    else send(res, 400, { error: "請求格式不對。" });
    return undefined;
  }
}

async function runCommand(req: IncomingMessage, res: ServerResponse, deps: ConsoleDeps, id: string): Promise<void> {
  if (!Object.hasOwn(COMMANDS, id)) return send(res, 404, { error: "沒有這個指令。" });
  const def = COMMANDS[id as CommandId];
  const b = await body(req, res);
  if (!b) return;
  let argv: string[];
  try {
    argv = def.argv(b);
  } catch (e) {
    if (e instanceof ArgError) return send(res, 400, { error: e.message, field: e.field });
    throw e;
  }
  const tier = def.tier(b);
  if (tier === "confirm" && b.confirm !== true) return send(res, 428, { need: "confirm" });
  if (tier === "typed") {
    const target = def.target(b);
    if (b.confirmText !== target) return send(res, 428, { need: "typed", target });
  }
  let cwd = deps.home;
  if (def.scope === "project") {
    const dir = deps.projectDir(String(b.project));
    if (!dir) return send(res, 404, { error: "沒有這個專案。" });
    cwd = dir;
  }
  if (def.mode(b) === "short") {
    const result = await runShort(deps.cli, deps.home, argv, { cwd, timeoutMs: deps.shortTimeoutMs ?? 120_000 });
    return send(res, 200, { mode: "short", ...result });
  }
  const job = startJob(deps.cli, deps.home, path.join(deps.home, "web-jobs"), id, argv, cwd);
  send(res, 202, { mode: "detached", jobId: job.id, pid: job.pid });
}

function answersOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof v !== "string" || v.length > 20_000 || !NAME_RE.test(k)) return undefined;
    out[k] = v;
  }
  return out;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: ConsoleDeps): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith("/api/")) return false;
  const jobsDir = path.join(deps.home, "web-jobs");
  try {
    if (req.method === "POST" && p.startsWith("/api/cmd/")) {
      await runCommand(req, res, deps, p.slice("/api/cmd/".length));
    } else if (req.method === "GET" && p === "/api/jobs") {
      send(res, 200, { jobs: listJobs(jobsDir) });
    } else if (req.method === "GET" && p.startsWith("/api/jobs/")) {
      const job = readJob(jobsDir, p.slice("/api/jobs/".length));
      if (job) send(res, 200, job);
      else send(res, 404, { error: "找不到這個任務。" });
    } else if (req.method === "GET" && p === "/api/ask") {
      const project = url.searchParams.get("project") ?? "";
      const run = url.searchParams.get("run") ?? "";
      if (!NAME_RE.test(project) || !NAME_RE.test(run)) {
        send(res, 400, { error: "請求格式不對。" });
        return true;
      }
      const ask = deps.readAsk(project, run);
      if (ask) send(res, 200, ask);
      else send(res, 404, { error: "這次任務沒有待回答的問題。" });
    } else if (req.method === "POST" && p === "/api/ask/answers") {
      const b = await body(req, res);
      if (!b) return true;
      const project = typeof b.project === "string" ? b.project : "";
      const run = typeof b.run === "string" ? b.run : "";
      const answers = answersOf(b.answers);
      if (!NAME_RE.test(project) || !NAME_RE.test(run) || !answers || (b.assumeDefaults !== undefined && typeof b.assumeDefaults !== "boolean")) {
        send(res, 400, { error: "請求格式不對。" });
        return true;
      }
      send(res, 200, deps.saveAnswers(project, run, answers, b.assumeDefaults === true));
    } else {
      send(res, 404, { error: "沒有這個 API。" });
    }
  } catch (e) {
    send(res, 500, { error: (e as Error).message || "伺服器出錯。" });
  }
  return true;
}

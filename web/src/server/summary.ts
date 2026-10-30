import type { IncomingMessage, ServerResponse } from "node:http";
import { leadCli, progressPrompt, runReport } from "./brief.js";
import type { WatchFactory, WebHub } from "./hub.js";

const BODY_LIMIT = 2048;

export async function handleSummary(req: IncomingMessage, res: ServerResponse, hub: WebHub, summarize: WatchFactory["summarize"]): Promise<void> {
  let body: unknown;
  try {
    body = parseBody(await readBody(req));
  } catch (error) {
    json(res, 400, { error: error instanceof BodyTooLarge ? "請求太大。" : "請求格式不對。" });
    return;
  }
  const project = field(body, "project");
  const runId = field(body, "runId");
  if (!project || !runId) {
    json(res, 400, { error: "請求格式不對。" });
    return;
  }
  if (!summarize) {
    json(res, 500, { error: "這個頁面不能總結進度。" });
    return;
  }
  const frame = hub.frame(project);
  const report = frame && !frame.error ? runReport(frame, runId) : undefined;
  if (!report?.run) {
    json(res, 404, { error: "找不到這次任務。" });
    return;
  }
  const runtime = leadCli(report.agents);
  if (!runtime) {
    json(res, 409, { error: "這位 lead 沒有可用的執行環境。" });
    return;
  }
  try {
    const text = (await summarize({ runtime, prompt: progressPrompt(report) })).trim();
    if (!text) {
      json(res, 502, { error: "沒有寫出摘要。" });
      return;
    }
    json(res, 200, { text });
  } catch (error) {
    json(res, 502, { error: (error as Error).message || "沒有寫出摘要。" });
  }
}

function field(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseBody(text: string): unknown {
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
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
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", fail);
  });
}

function json(res: ServerResponse, status: number, body: { text?: string; error?: string }): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

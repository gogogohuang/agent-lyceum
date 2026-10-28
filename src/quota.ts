import { spawn } from "node:child_process";

export type QuotaWindow = { label: string; used_percent: number; remaining_percent: number; resets: string };
export type QuotaReport = { runtime: "claude" | "codex"; windows: QuotaWindow[]; error?: string };

export function parseClaudeUsage(text: string): QuotaWindow[] {
  const session = text.match(/Current session:\s*(\d+(?:\.\d+)?)%\s*used\s*·\s*resets\s+(.+)/);
  const week = text.match(/Current week(?: \([^)]*\))?:\s*(\d+(?:\.\d+)?)%\s*used\s*·\s*resets\s+(.+)/);
  const windows: QuotaWindow[] = [];
  if (session) windows.push(windowOf("這 5 小時", Number(session[1]), (session[2] ?? "").trim()));
  if (week) windows.push(windowOf("本週", Number(week[1]), (week[2] ?? "").trim()));
  return windows;
}

type LimitWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
type RateLimits = { primary?: LimitWindow | null; secondary?: LimitWindow | null };

export function codexWindows(limits: RateLimits): QuotaWindow[] {
  return [limits.primary, limits.secondary].flatMap((window) => {
    if (!window || window.usedPercent === undefined) return [];
    const mins = window.windowDurationMins ?? 0;
    const resets = window.resetsAt ? new Date(window.resetsAt * 1000).toLocaleString("zh-Hant", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "時間不明";
    return [windowOf(durationLabel(mins), window.usedPercent, resets)];
  });
}

function durationLabel(mins: number): string {
  if (mins === 300) return "這 5 小時";
  if (mins === 10080) return "7 天";
  if (mins > 0 && mins % 1440 === 0) return `${mins / 1440} 天`;
  if (mins > 0 && mins % 60 === 0) return `${mins / 60} 小時`;
  return mins > 0 ? `${mins} 分鐘` : "用量";
}

function windowOf(label: string, used: number, resets: string): QuotaWindow {
  const usedPercent = roundPercent(used);
  return { label, used_percent: usedPercent, remaining_percent: roundPercent(Math.max(0, 100 - used)), resets };
}

function roundPercent(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function claudeQuota(): Promise<QuotaReport> {
  try {
    const text = await capture("claude", ["-p", "--no-session-persistence", "--output-format", "text", "/usage"], 20_000);
    const windows = parseClaudeUsage(text.stdout);
    if (windows.length === 0) return { runtime: "claude", windows: [], error: firstLine(text.stderr) || firstLine(text.stdout) || "claude /usage 沒有回傳額度。" };
    return { runtime: "claude", windows };
  } catch (error) {
    return { runtime: "claude", windows: [], error: missing("claude", error) };
  }
}

export async function codexQuota(): Promise<QuotaReport> {
  try {
    const limits = await readCodexLimits();
    return { runtime: "codex", windows: codexWindows(limits) };
  } catch (error) {
    return { runtime: "codex", windows: [], error: missing("codex", error) };
  }
}

function missing(cmd: string, error: unknown): string {
  const code = (error as { code?: string }).code;
  if (code === "ENOENT") return `找不到 ${cmd}。`;
  return (error as Error).message || `${cmd} 沒有回傳額度。`;
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function capture(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} 超過 ${Math.round(timeoutMs / 1000)} 秒沒有回應。`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
}

function readCodexLimits(): Promise<RateLimits> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("codex 超過 20 秒沒有回應。"));
    }, 20_000);
    let done = false;
    const finish = (error?: Error, limits?: RateLimits) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(limits ?? {});
    };
    child.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk) => {
      buf += String(chunk);
      let cut = buf.indexOf("\n");
      while (cut >= 0) {
        const line = buf.slice(0, cut).trim();
        buf = buf.slice(cut + 1);
        cut = buf.indexOf("\n");
        if (!line) continue;
        let message: { id?: number; error?: { message?: string }; result?: { rateLimits?: RateLimits } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} })}\n`);
        }
        if (message.id === 2) {
          if (message.error) finish(new Error(message.error.message || "codex 沒有回傳額度。"));
          else finish(undefined, message.result?.rateLimits ?? {});
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "agent-lyceum", version: "0" }, capabilities: {} } })}\n`);
  });
}

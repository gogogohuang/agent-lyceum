import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export type QuotaWindow = { label: string; used_percent: number; remaining_percent: number; resets: string };
export type QuotaReport = { runtime: "claude" | "codex" | "cursor"; windows: QuotaWindow[]; error?: string };

export type CursorTokenReaders = {
  readCliToken?: () => string | undefined;
  readEnvApiKey?: () => string | undefined;
  readIdeToken?: () => string | undefined;
};

export type CursorQuotaDeps = {
  resolveToken?: () => string | undefined;
  fetchUsage?: (token: string, signal?: AbortSignal) => Promise<unknown>;
};

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

export async function claudeQuota(signal?: AbortSignal): Promise<QuotaReport> {
  try {
    const text = await capture("claude", ["-p", "--no-session-persistence", "--output-format", "text", "/usage"], 20_000, signal);
    const windows = parseClaudeUsage(text.stdout);
    if (windows.length === 0) return { runtime: "claude", windows: [], error: firstLine(text.stderr) || firstLine(text.stdout) || "claude /usage 沒有回傳額度。" };
    return { runtime: "claude", windows };
  } catch (error) {
    if (isAbort(error)) throw error;
    return { runtime: "claude", windows: [], error: missing("claude", error) };
  }
}

export async function codexQuota(signal?: AbortSignal): Promise<QuotaReport> {
  try {
    const limits = await readCodexLimits(signal);
    return { runtime: "codex", windows: codexWindows(limits) };
  } catch (error) {
    if (isAbort(error)) throw error;
    return { runtime: "codex", windows: [], error: missing("codex", error) };
  }
}

type CursorPlanUsage = {
  totalPercentUsed?: number;
  limit?: number;
  remaining?: number;
};

type CursorPeriodUsage = {
  billingCycleStart?: string | number;
  billingCycleEnd?: string | number;
  planUsage?: CursorPlanUsage | null;
};

/** Map DashboardService/GetCurrentPeriodUsage into the shared QuotaWindow shape. */
export function parseCursorUsage(data: CursorPeriodUsage): QuotaWindow[] {
  const used = usedPercentOf(data.planUsage);
  if (used === undefined) return [];
  const endMs = millis(data.billingCycleEnd);
  const startMs = millis(data.billingCycleStart);
  const resets = endMs === undefined
    ? "時間不明"
    : new Date(endMs).toLocaleString("zh-Hant", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return [windowOf(cycleLabel(startMs, endMs), used, resets)];
}

export function resolveCursorAccessToken(readers: CursorTokenReaders = {}): string | undefined {
  const readCli = readers.readCliToken ?? defaultReadCliToken;
  const readEnv = readers.readEnvApiKey ?? (() => process.env.CURSOR_API_KEY);
  const readIde = readers.readIdeToken ?? defaultReadIdeToken;
  return firstToken(readCli(), readEnv(), readIde());
}

export async function cursorQuota(signal?: AbortSignal, deps: CursorQuotaDeps = {}): Promise<QuotaReport> {
  try {
    const token = (deps.resolveToken ?? (() => resolveCursorAccessToken()))();
    if (!token) {
      return {
        runtime: "cursor",
        windows: [],
        error: "Cursor 未登入。請先執行 agent login，或設定 CURSOR_API_KEY。",
      };
    }
    const fetchUsage = deps.fetchUsage ?? fetchCursorPeriodUsage;
    const windows = parseCursorUsage((await fetchUsage(token, signal)) as CursorPeriodUsage);
    if (windows.length === 0) return { runtime: "cursor", windows: [], error: "cursor 沒有回傳額度。" };
    return { runtime: "cursor", windows };
  } catch (error) {
    if (isAbort(error)) throw error;
    return { runtime: "cursor", windows: [], error: (error as Error).message || "cursor 沒有回傳額度。" };
  }
}

function usedPercentOf(plan?: CursorPlanUsage | null): number | undefined {
  if (!plan) return undefined;
  if (typeof plan.totalPercentUsed === "number" && Number.isFinite(plan.totalPercentUsed)) return plan.totalPercentUsed;
  const limit = plan.limit;
  const remaining = plan.remaining;
  if (typeof limit === "number" && limit > 0 && typeof remaining === "number" && Number.isFinite(remaining)) {
    return ((limit - remaining) / limit) * 100;
  }
  return undefined;
}

function cycleLabel(startMs?: number, endMs?: number): string {
  if (startMs === undefined || endMs === undefined || endMs <= startMs) return "計費週期";
  const days = (endMs - startMs) / 86_400_000;
  if (days >= 6 && days <= 8) return "本週";
  if (days >= 27 && days <= 32) return "本月";
  return "計費週期";
}

function millis(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function firstToken(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function defaultReadCliToken(): string | undefined {
  for (const file of cursorAuthJsonPaths()) {
    const token = readAccessTokenFromJsonFile(file);
    if (token) return token;
  }
  return readCursorKeychainToken();
}

function cursorAuthJsonPaths(): string[] {
  const home = os.homedir();
  const paths = [path.join(home, ".cursor", "auth.json")];
  if (process.platform === "linux" || process.env.XDG_CONFIG_HOME) {
    paths.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "cursor", "auth.json"));
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    paths.push(path.join(appData, "Cursor", "auth.json"));
  }
  return paths;
}

function readAccessTokenFromJsonFile(file: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { accessToken?: unknown };
    return typeof raw.accessToken === "string" ? raw.accessToken : undefined;
  } catch {
    return undefined;
  }
}

/** Cursor Agent CLI stores the session JWT in the macOS keychain as cursor-access-token. */
function readCursorKeychainToken(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

function defaultReadIdeToken(): string | undefined {
  const dbPath = cursorIdeStateDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) return undefined;
  const fromNode = readIdeTokenViaNodeSqlite(dbPath);
  if (fromNode) return fromNode;
  return readIdeTokenViaSqliteCli(dbPath);
}

function cursorIdeStateDbPath(): string | undefined {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(config, "Cursor", "User", "globalStorage", "state.vscdb");
}

function readIdeTokenViaNodeSqlite(dbPath: string): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => { prepare: (sql: string) => { get: (...args: unknown[]) => { value?: unknown } | undefined }; close: () => void } };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
      return normalizeSqliteText(row?.value);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function readIdeTokenViaSqliteCli(dbPath: string): string | undefined {
  try {
    const out = execFileSync("sqlite3", [dbPath, "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return normalizeSqliteText(out.trim());
  } catch {
    return undefined;
  }
}

function normalizeSqliteText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : trimmed.slice(1, -1);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

async function fetchCursorPeriodUsage(token: string, signal?: AbortSignal): Promise<unknown> {
  const base = (process.env.CURSOR_API_ENDPOINT || "https://api2.cursor.sh").replace(/\/$/, "");
  const timeout = AbortSignal.timeout(20_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${base}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal: combined,
    });
  } catch (error) {
    // Hub aborts → AbortError (discard). Own 20s timeout → plain Error (report, keep Claude/Codex).
    if (signal?.aborted) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    if (isAbort(error) || (error as { name?: string }).name === "TimeoutError") {
      throw new Error("cursor 超過 20 秒沒有回應。");
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`cursor 額度 API HTTP ${response.status}`);
  }
  return response.json();
}

/** An aborted quota read is a cancelled request, not a report: callers (the hub) discard it. */
function isAbort(error: unknown): boolean {
  return (error as { name?: string }).name === "AbortError";
}

function missing(cmd: string, error: unknown): string {
  const code = (error as { code?: string }).code;
  if (code === "ENOENT") return `找不到 ${cmd}。`;
  return (error as Error).message || `${cmd} 沒有回傳額度。`;
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function capture(cmd: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...(signal ? { signal } : {}) });
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

function readCodexLimits(signal?: AbortSignal): Promise<RateLimits> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], ...(signal ? { signal } : {}) });
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

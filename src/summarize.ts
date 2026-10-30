import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TIMEOUT_MS = 90_000;
const CAP = 200_000;

/** One local CLI call. The prompt already says what to write; this only runs it. */
export async function summarizeProgress(runtime: "claude" | "codex", prompt: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-summary-"));
  try {
    const text = runtime === "claude" ? await claude(dir, prompt) : await codex(dir, prompt);
    const trimmed = text.trim();
    if (!trimmed) throw new Error("沒有寫出摘要。");
    return trimmed;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function claude(dir: string, prompt: string): Promise<string> {
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(
    settings,
    JSON.stringify({
      disableAllHooks: true,
      permissions: { deny: ["Bash", "Edit", "Write", "NotebookEdit", "WebSearch", "WebFetch", "Agent", "Read", "Glob", "Grep"] },
    }),
  );
  const result = await run(
    "claude",
    ["-p", "--no-session-persistence", "--output-format", "text", "--permission-mode", "dontAsk", "--settings", settings],
    prompt,
    dir,
  );
  if (!result.stdout.trim()) throw new Error(first(result.stderr) || "claude 沒有寫出摘要。");
  return result.stdout;
}

async function codex(dir: string, prompt: string): Promise<string> {
  const last = path.join(dir, "last.txt");
  const result = await run("codex", ["exec", "-C", dir, "-s", "read-only", "--skip-git-repo-check", "-c", 'approval_policy="never"', "-o", last, "-"], prompt, dir);
  let text = "";
  try {
    text = fs.readFileSync(last, "utf8");
  } catch {
    text = "";
  }
  if (!text.trim()) text = result.stdout;
  if (!text.trim()) throw new Error(first(result.stderr) || "codex 沒有寫出摘要。");
  return text;
}

function first(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function run(cmd: string, args: string[], stdin: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`${cmd} 超過 ${Math.round(TIMEOUT_MS / 1000)} 秒沒有回應。`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + String(chunk)).slice(0, CAP);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(0, CAP);
    });
    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === "ENOENT" ? new Error(`找不到 ${cmd}。`) : error);
    });
    child.on("close", () => finish());
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

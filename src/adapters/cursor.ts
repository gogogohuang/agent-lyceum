import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoDirFor, scratchCwd, writePolicy } from "../policy.js";
import type { ErrorKind } from "../schema.js";
import { applyShipToWake } from "../ship-wire.js";
import { runtimeEnv } from "./env.js";
import type { Invocation, Parsed, StreamParser, WakeInput } from "./types.js";

const CLI_CONFIG_FILE = "cli-config.json";

/** Cursor permission token for a path: covers the path itself and, when it is (or may become) a directory, everything under it. */
function denyRules(p: string): string[] {
  let isFile = false;
  try {
    isFile = fs.statSync(p).isFile();
  } catch {
    /* missing: cover both */
  }
  return isFile ? [`Write(${p})`] : [`Write(${p})`, `Write(${p}/**)`];
}

/** Credential files carried from the user's Cursor config dir into the per-run one (`CURSOR_CONFIG_DIR` replaces the whole dir, so login would be lost). */
const AUTH_FILES = ["auth.json"];

/** The user's own Cursor config dir: the one the CLI would read without our override. */
function sourceConfigDir(): string {
  return process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), ".cursor");
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // missing or malformed: ignore the source config
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Links (preferred) or copies auth files that exist in `src` into `workDir`; never touches cli-config.json.
 * `workDir` is run-scoped: nothing relies on the credentials staying there beyond the wake. A symlink leaves no second
 * copy of the secret behind; the copy is only the fallback where symlinks are not allowed.
 */
function carryAuthFiles(src: string, workDir: string): void {
  if (path.resolve(src) === path.resolve(workDir)) return;
  for (const name of AUTH_FILES) {
    const from = path.join(src, name);
    const to = path.join(workDir, name);
    try {
      if (!fs.statSync(from).isFile()) continue;
      fs.rmSync(to, { force: true }); // a stale link or copy from an earlier wake
      try {
        fs.symlinkSync(path.resolve(from), to);
      } catch {
        fs.copyFileSync(from, to);
      }
    } catch {
      /* absent: nothing to carry */
    }
  }
}

/**
 * Writes `cli-config.json` under `workDir` (read via `CURSOR_CONFIG_DIR`, so the repo's own `.cursor/cli.json` is never touched).
 * Carries auth files and keeps the user's `version`/`editor` when present. Permissions.allow is **only** lyceum's Write/WebFetch
 * rules (never the user's allow — that could import `Shell(*)` etc.). Deny is unioned with the user's deny (stricter).
 * Web: denied unless `allowWeb` is `fetch`. `search` has no Cursor permission token, so it stays denied (documented gap).
 * Shell under `--force` follows Cursor's default approval rules; we do not emit a broad `Shell(*)` allow.
 */
export function writeCursorCliConfig(workDir: string, input: WakeInput): string {
  const { project, agent } = input;
  const pol = input.policy ?? writePolicy(project, agent);
  const allow: string[] = [...pol.allowDirs.map((d) => `Write(${d}/**)`), ...pol.allowFiles.map((f) => `Write(${f})`)];
  const deny = pol.deny.flatMap(denyRules);
  if (agent.allowWeb === "fetch" && !input.policy) allow.push("WebFetch(*)");
  else deny.push("WebFetch(*)");

  fs.mkdirSync(workDir, { recursive: true });
  const src = sourceConfigDir();
  carryAuthFiles(src, workDir);
  const base = path.resolve(src) === path.resolve(workDir) ? undefined : readJsonObject(path.join(src, CLI_CONFIG_FILE));
  const srcPerms = base?.permissions as { allow?: unknown; deny?: unknown } | undefined;
  const version = typeof base?.version === "number" ? base.version : 1;
  const editor = base?.editor && typeof base.editor === "object" && !Array.isArray(base.editor) ? base.editor : { vimMode: false };

  const file = path.join(workDir, CLI_CONFIG_FILE);
  const cfg = {
    version,
    editor,
    permissions: {
      allow: [...new Set(allow)],
      deny: [...new Set([...deny, ...strings(srcPerms?.deny)])],
    },
  };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

/** The prompt travels as one argv entry (spike: no stdin path), so the OS argument limit bounds it. */
export const MAX_PROMPT_BYTES = 100_000;

/** Persona + task as the positional argument (as with Codex). Guards the argv size and keeps a leading `-` from reading as a flag. */
function promptArg(systemPrompt: string, userPrompt: string): string {
  const prompt = `${systemPrompt}\n\n=====\n\n${userPrompt}`;
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > MAX_PROMPT_BYTES) throw new Error(`Cursor prompt too long for argv: ${bytes} bytes > ${MAX_PROMPT_BYTES} (cursor passes the prompt as a command-line argument)`);
  // The agent CLI is not known to accept `--`, so a harmless leading newline stops a flag-looking prompt from being parsed as an option.
  return prompt.startsWith("-") ? `\n${prompt}` : prompt;
}

export function buildCursorInvocation(raw: WakeInput): Invocation {
  const { input } = applyShipToWake(raw);
  const { project, agent, workDir } = input;
  const prompt = promptArg(input.systemPrompt, input.userPrompt); // before any file is created
  const repo = input.policy ? scratchCwd(workDir) : repoDirFor(project, agent.name);
  fs.mkdirSync(workDir, { recursive: true });
  if (input.policy) fs.mkdirSync(repo, { recursive: true });
  writeCursorCliConfig(workDir, input);

  // Writable paths outside --workspace (memory, outbox, ...) need --add-dir as well as the Write(...) rules, like Claude.
  // workDir is deliberately not added (not a writable path; also holds the ship session).
  const pol = input.policy ?? writePolicy(project, agent);
  const addDirs = [...new Set([...pol.allowDirs, ...pol.allowFiles.map((f) => path.dirname(f))].filter((d) => !(d === repo || d.startsWith(repo + path.sep))))];

  const args = ["-p", "--force", "--trust", "--sandbox", "enabled", "--workspace", repo];
  // Placed before other flags so a variadic --add-dir can never swallow the positional prompt.
  for (const d of addDirs) args.push("--add-dir", d);
  args.push("--output-format", "stream-json");
  if (agent.model) args.push("--model", agent.model);
  if (input.sessionId) args.push("--resume", input.sessionId);
  args.push(prompt);

  return {
    cmd: "agent",
    args,
    stdin: "",
    cwd: repo,
    env: { ...runtimeEnv(agent), CURSOR_CONFIG_DIR: workDir },
    parse({ stdout, stderr, code }) {
      const s = cursorStream();
      for (const l of stdout.split("\n")) s.line(l);
      return s.finish({ code, stdoutTail: stdout, stderrTail: stderr });
    },
    stream: () => cursorStream(),
  };
}

interface CursorResult {
  type?: string;
  is_error?: boolean;
  result?: unknown;
  session_id?: unknown;
}

function parseEvent(line: string): CursorResult | undefined {
  const t = line.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    const j = JSON.parse(t);
    return j && typeof j === "object" ? (j as CursorResult) : undefined;
  } catch {
    return undefined; // not json
  }
}

function cursorStream(): StreamParser {
  let sessionId: string | undefined;
  let last: CursorResult | undefined;
  return {
    line(l) {
      const e = parseEvent(l);
      if (!e) return;
      if (typeof e.session_id === "string") sessionId = e.session_id;
      if (e.type === "result") last = e;
    },
    finish({ code, stdoutTail, stderrTail }) {
      return finishCursor(last, sessionId, stdoutTail, stderrTail, code);
    },
  };
}

function finishCursor(result: CursorResult | undefined, sessionId: string | undefined, stdout: string, stderr: string, code: number | null): Parsed {
  const text = typeof result?.result === "string" ? result.result : "";
  const ok = code === 0 && !!result && !result.is_error;
  if (ok) return { ok, text, sessionId };
  const resultError = result?.is_error ? text : undefined;
  return {
    ok,
    text: result ? text : stdout,
    sessionId,
    error: (resultError || stderr || stdout || `exit code ${code}`).slice(-500),
    kind: classifyCursorError({ code, stdout, stderr, result: resultError }),
  };
}

interface Rule {
  kind: ErrorKind;
  re: RegExp;
}

/**
 * Ordered, first match wins: a spent quota is more specific than a 429.
 * Patterns follow the Codex adapter style (status/phrase anchors), documented/expected — not yet observed in real Cursor logs.
 */
const CURSOR_RULES: Rule[] = [
  { kind: "quota", re: /insufficient_quota|exceeded your (current )?quota|usage limit|out of (usage|credits)|quota (exceeded|exhausted)/i },
  { kind: "rate_limit", re: /\bstatus:? 429\b|\b429 too many requests|rate_limit_exceeded|rate[ _]limit (reached|exceeded)/i },
  { kind: "auth", re: /\bstatus:? 401\b|\b401 unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|not logged in|agent login|authentication (required|failed)/i },
  { kind: "network", re: /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network (error|unreachable)|fetch failed/i },
  { kind: "crash", re: /segmentation fault|panicked at|heap out of memory/i },
];

/** Reads the error channels only (the result message of a failed run, else stderr): stdout carries the agent's own words. */
export function classifyCursorError(out: { code: number | null; stdout: string; stderr: string; result?: string }): ErrorKind {
  let text = out.result ?? out.stderr;
  if (!text) {
    // a failed `result` event in stdout is the final verdict when stderr is silent
    for (const l of out.stdout.split("\n").reverse()) {
      const e = parseEvent(l);
      if (e?.type === "result" && e.is_error && typeof e.result === "string") {
        text = e.result;
        break;
      }
    }
  }
  const hit = CURSOR_RULES.find((r) => r.re.test(text));
  if (hit) return hit.kind;
  return out.code === null ? "crash" : "unknown";
}

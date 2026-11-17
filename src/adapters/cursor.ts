import fs from "node:fs";
import path from "node:path";
import { repoDirFor, scratchCwd, writePolicy } from "../policy.js";
import type { ErrorKind } from "../schema.js";
import { applyShipToWake } from "../ship-wire.js";
import { ApprovalError } from "../approval-error.js";
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

/**
 * Writes `cli-config.json` under `workDir` (read via `CURSOR_CONFIG_DIR`, so the repo's own `.cursor/cli.json` is never touched).
 * Web: denied unless `allowWeb` is `fetch`. `search` has no Cursor permission token, so it stays denied (documented gap).
 */
export function writeCursorCliConfig(workDir: string, input: WakeInput): string {
  const { project, agent } = input;
  const pol = input.policy ?? writePolicy(project, agent);
  const allow: string[] = [];
  const deny = pol.deny.flatMap(denyRules);
  if (agent.allowWeb === "fetch" && !input.policy) allow.push("WebFetch(*)");
  else deny.push("WebFetch(*)");

  fs.mkdirSync(workDir, { recursive: true });
  const file = path.join(workDir, CLI_CONFIG_FILE);
  const cfg = { version: 1, editor: { vimMode: false }, permissions: { allow, deny: [...new Set(deny)] } };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

export function buildCursorInvocation(raw: WakeInput): Invocation {
  const { input } = applyShipToWake(raw);
  const { project, agent, workDir } = input;
  // Same stance as Codex: no per-path hardening for enrolled agents, so refuse before anything is created.
  if (agent.enrolled) throw new ApprovalError("INVALID_INPUT", `Approval-enrolled agent cannot use Cursor: ${agent.name}`);
  const repo = input.policy ? scratchCwd(workDir) : repoDirFor(project, agent.name);
  fs.mkdirSync(workDir, { recursive: true });
  if (input.policy) fs.mkdirSync(repo, { recursive: true });
  writeCursorCliConfig(workDir, input);

  const args = ["-p", "--force", "--trust", "--sandbox", "enabled", "--workspace", repo, "--output-format", "stream-json"];
  if (agent.model) args.push("--model", agent.model);
  if (input.sessionId) args.push("--resume", input.sessionId);
  // Prompt is the positional argument (spike); the persona travels in it, as with Codex.
  args.push(`${input.systemPrompt}\n\n=====\n\n${input.userPrompt}`);

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

/** Ordered, first match wins: a spent quota is more specific than a 429. Patterns are documented/expected, not yet observed in real logs. */
const CURSOR_RULES: Rule[] = [
  { kind: "quota", re: /usage limit|out of (usage|credits)|quota (exceeded|exhausted)|insufficient_quota|exceeded your (current )?quota/i },
  { kind: "rate_limit", re: /\b429\b|too many requests|rate[ _]limit/i },
  { kind: "auth", re: /\b401\b|unauthori[sz]ed|not logged in|agent login|authentication (required|failed)|invalid api key/i },
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

import fs from "node:fs";
import path from "node:path";
import { repoDirFor, writePolicy } from "../policy.js";
import type { ErrorKind } from "../schema.js";
import type { Invocation, Parsed, StreamParser, WakeInput } from "./types.js";

export function codexWritableRoots(input: WakeInput): string[] {
  const pol = writePolicy(input.project, input.agent);
  const work = repoDirFor(input.project, input.agent.name);
  const roots = [...pol.allowDirs, ...pol.allowFiles.map((f) => path.dirname(f))].filter((d) => !(d === work || d.startsWith(work + path.sep)));
  return [...new Set(roots)];
}

function sessionIdOf(line: string): string | undefined {
  if (!line.trim().startsWith("{")) return undefined;
  try {
    const j = JSON.parse(line);
    const id = j.thread_id ?? j.session_id ?? j.conversation_id ?? j.msg?.session_id ?? j.msg?.thread_id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined; // not json
  }
}

function findSessionId(jsonl: string): string | undefined {
  for (const line of jsonl.split("\n")) {
    const id = sessionIdOf(line);
    if (id) return id;
  }
  return undefined;
}

function tokensOf(line: string): number | undefined {
  if (!line.trim().startsWith("{")) return undefined;
  try {
    const j = JSON.parse(line);
    return j.type === "turn.completed" && typeof j.usage?.output_tokens === "number" ? j.usage.output_tokens : undefined;
  } catch {
    return undefined; // not json
  }
}

/** Sum `output_tokens` over `turn.completed` events in `codex exec --json` output. */
export function codexOutputTokens(jsonl: string): number | undefined {
  let total: number | undefined;
  for (const line of jsonl.split("\n")) {
    const n = tokensOf(line);
    if (n !== undefined) total = (total ?? 0) + n;
  }
  return total;
}

/** Codex has one `web_search` setting: `cached` answers from an index, `live` browses. */
const CODEX_WEB_SEARCH = { none: "disabled", search: "cached", fetch: "live" } as const;

export function buildCodexInvocation(input: WakeInput): Invocation {
  const { project, agent, workDir } = input;
  const repo = repoDirFor(project, agent.name);
  fs.mkdirSync(workDir, { recursive: true });
  const lastFile = path.join(workDir, "codex-last-message.txt");
  const roots = codexWritableRoots(input);
  const common = [
    "-c",
    'approval_policy="never"',
    "-c",
    `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
    "--json",
    "-o",
    lastFile,
  ];
  if (agent.model) common.push("-m", agent.model);
  if (agent.effort) common.push("-c", `model_reasoning_effort="${agent.effort}"`);
  if (agent.allowWeb) common.push("-c", `web_search="${CODEX_WEB_SEARCH[agent.allowWeb]}"`);

  const args = input.sessionId
    ? ["exec", "resume", input.sessionId, "-c", 'sandbox_mode="workspace-write"', ...common, "-"]
    : ["exec", "-C", repo, "-s", "workspace-write", "--skip-git-repo-check", ...common, "-"];

  return {
    cmd: "codex",
    args,
    // Codex has no flag for a custom instruction file, so the persona travels in the prompt.
    stdin: `${input.systemPrompt}\n\n=====\n\n${input.userPrompt}`,
    cwd: repo,
    env: { ...process.env, AGENT_LYCEUM_AGENT: agent.name },
    parse({ stdout, stderr, code }) {
      return finishCodex(lastFile, findSessionId(stdout), codexOutputTokens(stdout), stdout, stderr, code);
    },
    stream(): StreamParser {
      // one pass over the events as they arrive; only the session id and the token total are kept
      let sessionId: string | undefined;
      let tokens: number | undefined;
      return {
        line(l) {
          sessionId ??= sessionIdOf(l);
          const n = tokensOf(l);
          if (n !== undefined) tokens = (tokens ?? 0) + n;
        },
        finish: ({ code, stdoutTail, stderrTail }) => finishCodex(lastFile, sessionId, tokens, stdoutTail, stderrTail, code),
      };
    },
  };
}

interface Rule {
  kind: ErrorKind;
  re: RegExp;
}

/**
 * Ordered, first match wins: put the more specific kind before the broader one (an exhausted quota also arrives as a 429).
 * Samples: observed = captured from a real `codex exec`, documented = from the CLI/API docs, not yet seen in a log.
 */
const CODEX_RULES: Rule[] = [
  // documented: `You exceeded your current quota` / `insufficient_quota`, ChatGPT plans: `You've hit your usage limit`
  { kind: "quota", re: /insufficient_quota|exceeded your current quota|hit your usage limit/i },
  // documented: `exceeded retry limit, last status: 429 Too Many Requests`, `rate_limit_exceeded`
  { kind: "rate_limit", re: /\b429\b|too many requests|rate.?limit/i },
  // observed: `unexpected status 401 Unauthorized: Incorrect API key provided ... invalid_api_key`; documented: `Not logged in`
  { kind: "auth", re: /\b401\b|unauthorized|invalid_api_key|incorrect api key|not logged in|codex login/i },
  // observed: `Reconnecting... waiting for network (Connection failed: error sending request)`; documented: DNS / Node error codes
  { kind: "network", re: /waiting for network|error sending request|dns error|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i },
  { kind: "crash", re: /segmentation fault|panicked at/i },
];

/** The message of the last `turn.failed` event: the final verdict, as opposed to the reconnect noise before it. */
function failureMessage(stdout: string): string | undefined {
  for (const line of stdout.split("\n").reverse()) {
    if (!line.includes('"turn.failed"')) continue;
    try {
      const m = JSON.parse(line).error?.message;
      if (typeof m === "string") return m;
    } catch {
      /* cut off by the tail window: not JSON */
    }
  }
  return undefined;
}

export function classifyCodexError(out: { code: number | null; stdout: string; stderr: string; result?: string }): ErrorKind {
  const text = out.result ?? failureMessage(out.stdout) ?? `${out.stderr}\n${out.stdout}`;
  const hit = CODEX_RULES.find((r) => r.re.test(text));
  if (hit) return hit.kind;
  return out.code === null ? "crash" : "unknown"; // killed by a signal; otherwise never guess crash
}

function finishCodex(lastFile: string, sessionId: string | undefined, outputTokens: number | undefined, stdout: string, stderr: string, code: number | null): Parsed {
  let text = "";
  try {
    text = fs.readFileSync(lastFile, "utf8");
  } catch {
    /* no last message */
  }
  const ok = code === 0;
  return { ok, text, sessionId, outputTokens, error: ok ? undefined : (stderr || stdout || `exit code ${code}`).slice(-500), kind: ok ? undefined : classifyCodexError({ code, stdout, stderr }) };
}

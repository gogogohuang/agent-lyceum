import fs from "node:fs";
import path from "node:path";
import { repoDirFor, scratchCwd, writePolicy, type WritePolicy } from "../policy.js";
import type { ResolvedAgent, ResolvedProject } from "../config.js";
import type { ErrorKind } from "../schema.js";
import { canonicalPath } from "../paths.js";
import type { Invocation, Parsed, StreamParser, WakeInput } from "./types.js";

/** Claude Code path rules: `//abs/path` — a leading "/" plus the absolute path. */
const rule = (tool: string, p: string) => `${tool}(/${p})`;

function denyRules(p: string): string[] {
  // Unknown whether it's a file or dir (may not exist yet): cover both.
  const out = [rule("Edit", p)];
  let isFile = false;
  try {
    isFile = fs.statSync(p).isFile();
  } catch {
    /* missing */
  }
  if (!isFile) out.push(rule("Edit", `${p}/**`));
  return out;
}

/** `override`: a policy that replaces the agent's own; `cwd` is then the (scratch) directory the runtime starts in, in place of the repo. */
export function buildClaudeSettings(project: ResolvedProject, agent: ResolvedAgent, override?: { policy: WritePolicy; cwd: string }): Record<string, unknown> {
  const pol = override?.policy ?? writePolicy(project, agent);
  const ws = override ? undefined : project.workspaces?.[agent.name];
  const repo = override?.cwd ?? repoDirFor(project, agent.name);
  const allow = ["Bash", "Read", "Glob", "Grep"];
  // Web tools are opt-in: `search` is the lighter one (snippets only), `fetch` also pulls whole pages into the agent's context.
  if (agent.allowWeb === "search" || agent.allowWeb === "fetch") allow.push("WebSearch");
  if (agent.allowWeb === "fetch") allow.push("WebFetch");
  allow.push(rule("Edit", `${repo}/**`));
  for (const d of pol.allowDirs) allow.push(rule("Edit", `${d}/**`));
  for (const f of pol.allowFiles) allow.push(rule("Edit", f));

  const deny = pol.deny.flatMap(denyRules);

  // Spec 25: network allowances; never with a policy override (a minimal-authority wake).
  const sb = override ? undefined : agent.sandbox;
  const network: Record<string, unknown> = {};
  if (sb?.network.length) network.allowedDomains = sb.network;
  if (sb?.localBinding) network.allowLocalBinding = true;
  if (sb?.unixSockets.length) network.allowUnixSockets = sb.unixSockets.map(canonicalPath);

  return {
    // The user's own and plugin hooks (e.g. a hook that asks the user a question) would block every tool call of a headless wake-up.
    disableAllHooks: true,
    permissions: { allow, deny },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [override?.cwd ?? ws?.root ?? project.dir, ...pol.allowDirs, ...pol.allowFiles],
        denyWrite: pol.deny,
      },
      ...(Object.keys(network).length ? { network } : {}),
    },
  };
}

export function buildClaudeInvocation(input: WakeInput): Invocation {
  const { project, agent, workDir } = input;
  fs.mkdirSync(workDir, { recursive: true });
  const settingsFile = path.join(workDir, "claude-settings.json");
  const systemFile = path.join(workDir, "system-prompt.md");
  const repo = input.policy ? scratchCwd(workDir) : repoDirFor(project, agent.name);
  const scope = input.policy ? { policy: input.policy, cwd: repo } : undefined;
  if (scope) fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(buildClaudeSettings(project, agent, scope), null, 2));
  fs.writeFileSync(systemFile, input.systemPrompt);

  const pol = input.policy ?? writePolicy(project, agent);
  const addDirs = [...pol.allowDirs, ...pol.readDirs, ...pol.allowFiles.map((f) => path.dirname(f))].filter((d) => !(d === repo || d.startsWith(repo + path.sep)));

  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--settings",
    settingsFile,
    "--append-system-prompt-file",
    systemFile,
  ];
  if (agent.model) args.push("--model", agent.model);
  if (agent.effort) args.push("--effort", agent.effort);
  if (input.sessionId) args.push("--resume", input.sessionId);
  for (const d of [...new Set(addDirs)]) args.push("--add-dir", d);

  return {
    cmd: "claude",
    args,
    stdin: input.userPrompt, // prompt via stdin: --add-dir is variadic and would swallow a positional prompt
    cwd: repo,
    env: { ...process.env, AGENT_LYCEUM_AGENT: agent.name },
    parse({ stdout, stderr, code }) {
      return interpretClaude(extractClaudeResult(stdout), stdout, stderr, code);
    },
    stream: () => claudeStream(),
  };
}

interface Rule {
  kind: ErrorKind;
  /** Matched against the failure text. */
  re: RegExp;
}

/**
 * Ordered, first match wins: put the more specific kind before the broader one (a usage limit is `quota`, not `rate_limit`).
 * Samples: observed = captured from a real run, documented = from the CLI/API docs, not yet seen in a log.
 */
const CLAUDE_RULES: Rule[] = [
  // observed: `Invalid API key · Fix external API key` with api_error_status 401; documented: `Not logged in · Please run /login`
  { kind: "auth", re: /\bHTTP 401\b|invalid api key|not logged in|please run \/login/i },
  // documented: `5-hour limit reached ∙ resets 3pm`, API 400 `Credit balance is too low`
  { kind: "quota", re: /\b(5-hour|weekly|usage) limit reached\b|credit balance is too low/i },
  // documented: API 429 `rate_limit_error`, 529 `overloaded_error`
  { kind: "rate_limit", re: /\bHTTP (429|529)\b|rate_limit_error|rate limit (reached|exceeded)|overloaded_error|^api error: overloaded/im },
  // observed: `API Error: Connection refused — ... (ECONNREFUSED)`; documented: the other Node error codes
  { kind: "network", re: /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i },
  // documented: a native crash prints one of these (a signal kill has no exit code, see `isSignalKill`)
  { kind: "crash", re: /segmentation fault|heap out of memory/i },
];

/** A process that ended without an exit code was killed by a signal that was not ours (timeouts and cancels never get here). */
const isSignalKill = (code: number | null) => code === null;

function classifyWith(rules: Rule[], code: number | null, text: string): ErrorKind {
  const hit = rules.find((r) => r.re.test(text));
  if (hit) return hit.kind;
  return isSignalKill(code) ? "crash" : "unknown"; // never default to crash: a wrong guess would switch models for nothing
}

/**
 * The text the rules read: the result message (only when it is an error message: pass `result` for an `is_error` run), stderr, and the HTTP status
 * the CLI reports as `api_error_status`. With no `result` and no result in stdout, stdout itself, but only when it is plain text: structured
 * output (starting with `{` or `[`) without a result is a transcript, and the agent's own words there must not read as an error.
 */
export function classifyClaudeError(out: { code: number | null; stdout: string; stderr: string; result?: string }): ErrorKind {
  const status = /"api_error_status":\s*(\d{3})/.exec(out.stdout)?.[1];
  const j = extractClaudeResult(out.stdout);
  const structured = /^[[{]/.test(out.stdout.trimStart());
  const message = out.result ?? (j ? (j.is_error ? String(j.result ?? "") : "") : structured ? "" : out.stdout);
  return classifyWith(CLAUDE_RULES, out.code, [message, out.stderr, status ? `HTTP ${status}` : ""].join("\n"));
}

function interpretClaude(j: ClaudeResult | undefined, stdout: string, stderr: string, code: number | null): Parsed {
  if (!j) return { ok: false, text: stdout, error: (stderr || stdout || `exit code ${code}`).slice(0, 500), kind: classifyClaudeError({ code, stdout, stderr }) };
  const ok = code === 0 && !j.is_error;
  return {
    ok,
    text: String(j.result ?? ""),
    sessionId: j.session_id,
    outputTokens: j.usage?.output_tokens,
    cacheReadTokens: j.usage?.cache_read_input_tokens,
    cacheWriteTokens: j.usage?.cache_creation_input_tokens,
    error: ok ? undefined : String(j.result ?? stderr).slice(0, 500),
    kind: ok ? undefined : classifyClaudeError({ code, stdout, stderr, result: j.is_error && j.result !== undefined ? String(j.result) : undefined }),
  };
}

/** Reads `--output-format json` output line by line: only JSON lines are kept, and only the last few, so a flood of other output costs nothing. */
function claudeStream(): StreamParser {
  const candidates: unknown[] = [];
  return {
    line(text) {
      if (text[0] !== "{" && text[0] !== "[") return;
      try {
        candidates.push(JSON.parse(text));
        if (candidates.length > 8) candidates.shift();
      } catch {
        /* not JSON: ignore the line */
      }
    },
    finish({ code, stdoutTail, stderrTail }) {
      for (const parsed of [...candidates].reverse()) {
        const j = pickClaudeResult(parsed);
        if (j) return interpretClaude(j, stdoutTail, stderrTail, code);
      }
      return interpretClaude(undefined, stdoutTail, stderrTail, code);
    },
  };
}

interface ClaudeResult {
  result?: string;
  session_id?: string;
  usage?: { output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  is_error?: boolean;
}

/** `--output-format json` prints either one result object or (newer versions) an array of events. */
function pickClaudeResult(parsed: unknown): ClaudeResult | undefined {
  if (Array.isArray(parsed)) {
    return [...parsed].reverse().find((e) => e && typeof e === "object" && (e as { type?: string }).type === "result") as ClaudeResult | undefined;
  }
  if (parsed && typeof parsed === "object") return parsed as ClaudeResult;
  return undefined;
}

export function extractClaudeResult(stdout: string): ClaudeResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    // maybe JSON lines: take the last parseable line
    for (const line of stdout.trim().split("\n").reverse()) {
      try {
        parsed = JSON.parse(line);
        break;
      } catch {
        /* keep looking */
      }
    }
  }
  return pickClaudeResult(parsed);
}

import fs from "node:fs";
import path from "node:path";
import { repoDirFor, writePolicy } from "../policy.js";
import type { Invocation, StreamParser, WakeInput } from "./types.js";

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

  const args = input.sessionId
    ? ["exec", "resume", input.sessionId, "-c", 'sandbox_mode="workspace-write"', ...common, "-"]
    : ["exec", "-C", repo, "-s", "workspace-write", "--skip-git-repo-check", ...common, "-"];

  return {
    cmd: "codex",
    args,
    // Codex has no flag for a custom instruction file, so the persona travels in the prompt.
    stdin: `${input.systemPrompt}\n\n=====\n\n${input.userPrompt}`,
    cwd: repo,
    env: { ...process.env, AGENT_TEAM_AGENT: agent.name },
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

function finishCodex(lastFile: string, sessionId: string | undefined, outputTokens: number | undefined, stdout: string, stderr: string, code: number | null) {
  let text = "";
  try {
    text = fs.readFileSync(lastFile, "utf8");
  } catch {
    /* no last message */
  }
  const ok = code === 0;
  return { ok, text, sessionId, outputTokens, error: ok ? undefined : (stderr || stdout || `exit code ${code}`).slice(-500) };
}

import fs from "node:fs";
import path from "node:path";
import { writePolicy } from "../policy.js";
import type { ResolvedAgent, ResolvedProject } from "../config.js";
import type { Invocation, WakeInput } from "./types.js";

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

export function buildClaudeSettings(project: ResolvedProject, agent: ResolvedAgent): Record<string, unknown> {
  const pol = writePolicy(project, agent);
  const allow = ["Bash", "Read", "Glob", "Grep"];
  if (pol.restrictRepoToOwns) {
    for (const g of pol.owns) allow.push(rule("Edit", path.join(project.dir, g)));
  } else {
    allow.push(rule("Edit", `${project.dir}/**`));
  }
  for (const d of pol.allowDirs) allow.push(rule("Edit", `${d}/**`));
  for (const f of pol.allowFiles) allow.push(rule("Edit", f));

  const deny = pol.deny.flatMap(denyRules);

  return {
    permissions: { allow, deny },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [project.dir, ...pol.allowDirs, ...pol.allowFiles],
        denyWrite: pol.deny,
      },
    },
  };
}

export function buildClaudeInvocation(input: WakeInput): Invocation {
  const { project, agent, workDir } = input;
  fs.mkdirSync(workDir, { recursive: true });
  const settingsFile = path.join(workDir, "claude-settings.json");
  const systemFile = path.join(workDir, "system-prompt.md");
  fs.writeFileSync(settingsFile, JSON.stringify(buildClaudeSettings(project, agent), null, 2));
  fs.writeFileSync(systemFile, input.systemPrompt);

  const pol = writePolicy(project, agent);
  const addDirs = [...pol.allowDirs, ...pol.allowFiles.map((f) => path.dirname(f))].filter(
    (d) => !(d === project.dir || d.startsWith(project.dir + path.sep)),
  );

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
    cwd: project.dir,
    env: { ...process.env, AGENT_TEAM_AGENT: agent.name },
    parse({ stdout, stderr, code }) {
      const j = extractClaudeResult(stdout);
      if (!j) return { ok: false, text: stdout, error: (stderr || stdout || `exit code ${code}`).slice(0, 500) };
      const ok = code === 0 && !j.is_error;
      return {
        ok,
        text: String(j.result ?? ""),
        sessionId: j.session_id,
        outputTokens: j.usage?.output_tokens,
        error: ok ? undefined : String(j.result ?? stderr).slice(0, 500),
      };
    },
  };
}

interface ClaudeResult {
  result?: string;
  session_id?: string;
  usage?: { output_tokens?: number };
  is_error?: boolean;
}

/** `--output-format json` prints either one result object or (newer versions) an array of events. */
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
  if (Array.isArray(parsed)) {
    return [...parsed].reverse().find((e) => e && typeof e === "object" && (e as { type?: string }).type === "result") as
      | ClaudeResult
      | undefined;
  }
  if (parsed && typeof parsed === "object") return parsed as ClaudeResult;
  return undefined;
}

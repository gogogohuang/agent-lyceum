import fs from "node:fs";
import path from "node:path";
import { writePolicy } from "../policy.js";
import type { Invocation, WakeInput } from "./types.js";

export function codexWritableRoots(input: WakeInput): string[] {
  const pol = writePolicy(input.project, input.agent);
  const repo = input.project.dir;
  const roots = [...pol.allowDirs, ...pol.allowFiles.map((f) => path.dirname(f))].filter(
    (d) => !(d === repo || d.startsWith(repo + path.sep)),
  );
  return [...new Set(roots)];
}

function findSessionId(jsonl: string): string | undefined {
  for (const line of jsonl.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const j = JSON.parse(line);
      const id = j.thread_id ?? j.session_id ?? j.conversation_id ?? j.msg?.session_id ?? j.msg?.thread_id;
      if (typeof id === "string") return id;
    } catch {
      /* not json */
    }
  }
  return undefined;
}

export function buildCodexInvocation(input: WakeInput): Invocation {
  const { project, agent, workDir } = input;
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
    : ["exec", "-C", project.dir, "-s", "workspace-write", "--skip-git-repo-check", ...common, "-"];

  return {
    cmd: "codex",
    args,
    // Codex has no flag for a custom instruction file, so the persona travels in the prompt.
    stdin: `${input.systemPrompt}\n\n=====\n\n${input.userPrompt}`,
    cwd: project.dir,
    env: { ...process.env, AGENT_TEAM_AGENT: agent.name },
    parse({ stdout, stderr, code }) {
      let text = "";
      try {
        text = fs.readFileSync(lastFile, "utf8");
      } catch {
        /* no last message */
      }
      const ok = code === 0;
      return {
        ok,
        text,
        sessionId: findSessionId(stdout),
        error: ok ? undefined : (stderr || stdout || `exit code ${code}`).slice(-500),
      };
    },
  };
}

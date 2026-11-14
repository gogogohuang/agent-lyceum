import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { repoDirFor, writePolicy } from "./policy.js";

export interface ShipSession {
  root: string;
  verify: string;
  deny: string[];
  timeoutSec: number;
}

export interface ShipWakeInfo {
  sessionPath: string;
  /** Exact argv a runtime should run (node + cli + ship --session …). */
  argv: string[];
  /** One-line shell form for prompts. */
  shellCommand: string;
}

/** True when the agent opted into ship (boolean true or an object). */
export function shipEnabled(agent: ResolvedAgent): boolean {
  return agent.ship !== undefined;
}

/** Default verify: agent.ship.verify → first project.verify.commands.run → undefined. */
export function shipDefaultVerify(project: ResolvedProject, agent: ResolvedAgent): string | undefined {
  if (agent.ship?.verify?.trim()) return agent.ship.verify.trim();
  const first = project.verify?.commands[0]?.run?.trim();
  return first || undefined;
}

export function shipTimeoutSec(agent: ResolvedAgent): number {
  return agent.ship?.timeoutSec ?? 120;
}

/** How to re-enter this package's CLI (`ship` subcommand). Works for dist and tsx/dev. */
export function shipCliArgv(): string[] {
  const cliJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  if (fs.existsSync(cliJs)) return [process.execPath, cliJs];
  const cli = process.argv[1];
  if (cli) return [process.execPath, ...process.execArgv, cli];
  return [process.execPath, cliJs];
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Write a per-wake ship session (root / verify / deny) for Claude Code and Codex.
 * Returns undefined when ship is off or verify cannot be resolved.
 */
export function writeShipSession(project: ResolvedProject, agent: ResolvedAgent, workDir: string): ShipWakeInfo | undefined {
  if (!shipEnabled(agent)) return undefined;
  const verify = shipDefaultVerify(project, agent);
  if (!verify) return undefined;
  const root = repoDirFor(project, agent.name);
  const pol = writePolicy(project, agent);
  const session: ShipSession = {
    root,
    verify,
    deny: pol.deny,
    timeoutSec: shipTimeoutSec(agent),
  };
  fs.mkdirSync(workDir, { recursive: true });
  const sessionPath = path.join(workDir, "ship-session.json");
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
  const argv = [...shipCliArgv(), "ship", "--session", sessionPath];
  const shellCommand = argv.map(shellQuote).join(" ");
  return { sessionPath, argv, shellCommand };
}

export function readShipSession(file: string): ShipSession {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ship session must be a JSON object");
  const o = raw as Record<string, unknown>;
  if (typeof o.root !== "string" || !o.root.trim()) throw new Error("ship session.root is required");
  if (typeof o.verify !== "string" || !o.verify.trim()) throw new Error("ship session.verify is required");
  if (!Array.isArray(o.deny) || o.deny.some((x) => typeof x !== "string")) throw new Error("ship session.deny must be a string array");
  const timeoutSec = typeof o.timeoutSec === "number" && Number.isInteger(o.timeoutSec) && o.timeoutSec > 0 ? o.timeoutSec : 120;
  return { root: o.root, verify: o.verify.trim(), deny: o.deny as string[], timeoutSec };
}

import type { WakeInput } from "./adapters/types.js";

/** Prompt block for both Claude Code and Codex (exact CLI; no MCP). */
export function formatShipPrompt(shellCommand: string, sessionPath: string): string {
  return [
    "## Ship (tested edits)",
    "Use the agent-lyceum `ship` CLI (not a separate product) for multi-file or must-pass-tests edits: it applies search/replace, runs the fixed verify command from your session, and restores every file byte-for-byte if verify fails.",
    "- Changing 2+ files, or any change that must pass a test or typecheck: run the command below once with every edit in the JSON on stdin.",
    "- Do not pass a different verify command; it is fixed in the session file.",
    "- If verify fails, fix the edit and ship again; do not leave a half-edited tree.",
    "- For one small edit to a file you already have open, your normal edit tool is fine.",
    "",
    "Command (stdin = JSON object with `edits` only):",
    "```",
    `${shellCommand} <<'EOF'`,
    `{"edits":[{"path":"relative/file.ts","search":"old","replace":"new"}]}`,
    "EOF",
    "```",
    `Session file (do not edit): \`${sessionPath}\``,
  ].join("\n");
}

/**
 * For Claude Code and Codex wakes: write the session and append the exact CLI to the system prompt.
 * Policy wakes (tidy, etc.) skip ship. Call from both adapters.
 */
export function applyShipToWake(input: WakeInput): { input: WakeInput; ship?: ShipWakeInfo } {
  if (input.policy) return { input };
  const ship = writeShipSession(input.project, input.agent, input.workDir);
  if (!ship) return { input };
  return {
    ship,
    input: {
      ...input,
      systemPrompt: `${input.systemPrompt}\n\n${formatShipPrompt(ship.shellCommand, ship.sessionPath)}`,
    },
  };
}

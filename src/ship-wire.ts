import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { repoDirFor, writePolicy } from "./policy.js";
import type { ShipCommand } from "./ship.js";

export interface ShipSession {
  root: string;
  commands: ShipCommand[];
  deny: string[];
}

const SHIP_DEFAULT_TIMEOUT_SEC = 120;

export interface ShipWakeInfo {
  sessionPath: string;
  /** Exact argv a runtime should run (node + cli + ship --session …). */
  argv: string[];
  /** One-line shell form for prompts. */
  shellCommand: string;
  /** Sum of the verify command timeouts: the longest one ship call can take. */
  totalTimeoutSec: number;
}

/** True when the agent opted into ship (boolean true or an object). */
export function shipEnabled(agent: ResolvedAgent): boolean {
  return agent.ship !== undefined;
}

/**
 * Verify chain for ship: agent.ship.verify (one command) → the whole project.verify.commands chain → none.
 * An explicit agent.ship.timeoutSec overrides every command's timeout; unset keeps each command's own.
 */
export function shipCommands(project: ResolvedProject, agent: ResolvedAgent): ShipCommand[] {
  const override = agent.ship?.timeoutSec;
  const own = agent.ship?.verify?.trim();
  if (own) return [{ name: "verify", run: own, timeout_sec: override ?? SHIP_DEFAULT_TIMEOUT_SEC }];
  return (project.verify?.commands ?? [])
    .filter((c) => c.run.trim())
    .map((c) => ({ name: c.name, run: c.run.trim(), timeout_sec: override ?? c.timeout_sec }));
}

export function shipTotalTimeoutSec(commands: ShipCommand[]): number {
  return commands.reduce((n, c) => n + c.timeout_sec, 0);
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
 * Write a per-wake ship session (root / commands / deny) for Claude Code, Codex and Cursor.
 * Returns undefined when ship is off or verify cannot be resolved.
 */
export function writeShipSession(project: ResolvedProject, agent: ResolvedAgent, workDir: string): ShipWakeInfo | undefined {
  if (!shipEnabled(agent)) return undefined;
  const commands = shipCommands(project, agent);
  if (!commands.length) return undefined;
  const root = repoDirFor(project, agent.name);
  const pol = writePolicy(project, agent);
  const session: ShipSession = {
    root,
    commands,
    deny: pol.deny,
  };
  fs.mkdirSync(workDir, { recursive: true });
  const sessionPath = path.join(workDir, "ship-session.json");
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
  const argv = [...shipCliArgv(), "ship", "--session", sessionPath];
  const shellCommand = argv.map(shellQuote).join(" ");
  return { sessionPath, argv, shellCommand, totalTimeoutSec: shipTotalTimeoutSec(commands) };
}

export function readShipSession(file: string): ShipSession {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ship session must be a JSON object");
  const o = raw as Record<string, unknown>;
  if (typeof o.root !== "string" || !o.root.trim()) throw new Error("ship session.root is required");
  if (!Array.isArray(o.deny) || o.deny.some((x) => typeof x !== "string")) throw new Error("ship session.deny must be a string array");
  return { root: o.root, commands: readCommands(o), deny: o.deny as string[] };
}

/** `commands` array, or the old single `verify` string (+ optional `timeoutSec`) as one command. */
function readCommands(o: Record<string, unknown>): ShipCommand[] {
  if (o.commands !== undefined) {
    if (!Array.isArray(o.commands) || o.commands.length === 0) throw new Error("ship session.commands must be a non-empty array");
    return o.commands.map((c, i) => {
      const r = c as Record<string, unknown> | null;
      if (!r || typeof r !== "object" || typeof r.name !== "string" || typeof r.run !== "string" || !r.run.trim()) {
        throw new Error(`ship session.commands[${i}] needs string name and run`);
      }
      if (typeof r.timeout_sec !== "number" || !Number.isInteger(r.timeout_sec) || r.timeout_sec <= 0) {
        throw new Error(`ship session.commands[${i}].timeout_sec must be a positive integer`);
      }
      return { name: r.name, run: r.run.trim(), timeout_sec: r.timeout_sec };
    });
  }
  if (typeof o.verify !== "string" || !o.verify.trim()) throw new Error("ship session.commands is required");
  const t = typeof o.timeoutSec === "number" && Number.isInteger(o.timeoutSec) && o.timeoutSec > 0 ? o.timeoutSec : SHIP_DEFAULT_TIMEOUT_SEC;
  return [{ name: "verify", run: o.verify.trim(), timeout_sec: t }];
}

import type { WakeInput } from "./adapters/types.js";

/** Prompt block for Claude Code, Codex and Cursor (exact CLI; no MCP). */
export function formatShipPrompt(shellCommand: string, sessionPath: string, totalTimeoutSec: number): string {
  return [
    "## Ship (tested edits)",
    "Use the agent-lyceum `ship` CLI (not a separate product) for multi-file or must-pass-tests edits: it applies search/replace, runs the fixed verify command from your session, and restores every file byte-for-byte if verify fails.",
    "- Changing 2+ files, or any change that must pass a test or typecheck: run the command below once with every edit in the JSON on stdin.",
    `- Verify can take up to ${totalTimeoutSec} seconds in total. Set your shell tool timeout above ${totalTimeoutSec} seconds for this command, or it may be killed mid-verify.`,
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
 * Policy wakes (tidy, etc.) skip ship. Call from every adapter.
 */
export function applyShipToWake(input: WakeInput): { input: WakeInput; ship?: ShipWakeInfo } {
  if (input.policy) return { input };
  const ship = writeShipSession(input.project, input.agent, input.workDir);
  if (!ship) return { input };
  return {
    ship,
    input: {
      ...input,
      systemPrompt: `${input.systemPrompt}\n\n${formatShipPrompt(ship.shellCommand, ship.sessionPath, ship.totalTimeoutSec)}`,
    },
  };
}

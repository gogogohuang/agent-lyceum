import fs from "node:fs";
import { runShip, type ShipEdit } from "./ship.js";
import { readShipSession } from "./ship-wire.js";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function parseShipEditsPayload(raw: unknown): ShipEdit[] {
  if (!isRecord(raw)) throw new Error("ship input must be a JSON object with edits");
  const edits = raw.edits;
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("edits must be a non-empty array");
  const out: ShipEdit[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!isRecord(e)) throw new Error(`edits[${i}] must be an object`);
    if (typeof e.path !== "string" || typeof e.search !== "string" || typeof e.replace !== "string") {
      throw new Error(`edits[${i}] needs string path, search, replace`);
    }
    if ("verify" in e) throw new Error("per-edit verify is not allowed; verify is fixed in the ship session");
    if ("replace_all" in e && e.replace_all !== true && e.replace_all !== false) {
      throw new Error(`edits[${i}].replace_all must be a boolean when set`);
    }
    out.push({
      path: e.path,
      search: e.search,
      replace: e.replace,
      ...(e.replace_all === true ? { replace_all: true } : {}),
    });
  }
  if ("verify" in raw) {
    throw new Error("verify in the request body is not allowed; it is fixed in the ship session");
  }
  return out;
}

/** Read stdin fully as UTF-8. */
export async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * CLI entry for both Claude Code and Codex: `agent-lyceum ship --session <file>` with edits JSON on stdin
 * (or `--edits <file>`). Exit 0 only on SHIPPED_AND_VERIFIED.
 */
export async function runShipCli(opts: { session: string; editsFile?: string }): Promise<number> {
  const session = readShipSession(opts.session);
  const text = opts.editsFile ? fs.readFileSync(opts.editsFile, "utf8") : await readStdinText();
  if (!text.trim()) throw new Error("edits JSON is empty (pass on stdin or --edits)");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`edits JSON is invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
  const edits = parseShipEditsPayload(raw);
  // Interrupted ship must roll back: abort verify (kills its process group), then runShip restores the files.
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const sig of signals) process.on(sig, onSignal);
  let result: Awaited<ReturnType<typeof runShip>>;
  try {
    result = await runShip({
      root: session.root,
      edits,
      verify: session.verify,
      timeoutSec: session.timeoutSec,
      deny: session.deny,
      signal: controller.signal,
    });
  } finally {
    for (const sig of signals) process.off(sig, onSignal);
  }
  process.stdout.write(`${result.status}\n${result.summary}\nfiles: ${result.filesModified.join(", ") || "(none)"}\n`);
  return result.status === "SHIPPED_AND_VERIFIED" ? 0 : 1;
}

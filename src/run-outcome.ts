import path from "node:path";
import type { DoneContract } from "./format.js";
import type { EndReason, RunFailure } from "./run-store.js";
import type { RunOutcome } from "./schema.js";

export interface UnintegratedWork {
  agent: string;
  branch: string;
  report: string;
}

/** What a lead's `done` amounts to: its declared outcome, unless the contract is broken or member work never reached the repo. */
export function resolveDoneOutcome(
  contract: DoneContract,
  rejections: number,
  unintegrated: UnintegratedWork[],
): { outcome: RunOutcome; note?: string; verification?: string } {
  const ok = contract.missing.length === 0;
  let outcome: RunOutcome = ok ? (contract.outcome ?? "partial") : "partial";
  let note = ok ? undefined : `Completion contract not met after ${rejections} reminder(s): missing ${contract.missing.join("; ")}. Reported as partial; the lead's report is kept as written.`;
  if (outcome === "completed" && unintegrated.length) {
    outcome = "blocked";
    note = `Not completed: work of ${unintegrated.map((b) => `${b.agent} (branch ${b.branch})`).join(", ")} was never brought into the repo; see ${unintegrated.map((b) => b.report).join(", ")}.`;
  }
  return { outcome, note, verification: contract.verification };
}

/** How a run turned out, from why it stopped (`done` carries the lead's own verdict). */
export function endOutcome(endReason: EndReason, done?: { outcome: RunOutcome; note?: string }, failure?: RunFailure): { outcome: RunOutcome; note?: string } {
  switch (endReason) {
    case "done":
      return { outcome: done?.outcome ?? "partial", note: done?.note };
    case "lead_failed":
    case "agent_failed":
      return {
        outcome: "failed",
        note: failure
          ? `${failure.agent} failed ${failure.attempts} time(s) in a row (${failure.error ?? "unknown error"}), so the run stopped. The message it was handling is still unread.`
          : "The lead's wake-up failed.",
      };
    case "waiting":
      return { outcome: "waiting", note: "Waiting for your answers. Fill in ask-reply.md or run `agent-lyceum resume <run-id> --answer`, then continue with `agent-lyceum resume`." };
    case "cancelled":
      return { outcome: "cancelled", note: "Cancelled before the lead finished. Unread mail was kept; continue with `agent-lyceum resume`." };
    case "idle":
      return { outcome: "partial", note: "All mailboxes were empty but the lead never sent a done message." };
    case "max_rounds":
      return { outcome: "partial", note: "Stopped at the round limit before the lead sent done." };
  }
}

/** What to tell the user when an agent kept failing and the run stopped: where to look, what to fix, how to go on. */
export function failureGuide(project: string, run: string, f: RunFailure, runDir: string): string {
  // With a fallback chain: every model given up on, in order.
  const tried = f.tried?.length
    ? ["Models tried, in order:", ...f.tried.map((t, i) => `  ${i + 1}. ${t.model ? `${t.runtime}/${t.model}` : t.runtime}: ${t.kind ?? "unknown error"}${t.error ? ` (${t.error})` : ""}`)]
    : [];
  return [
    "",
    `${f.agent} was called ${f.attempts} time(s) and failed every time (${f.error ?? "unknown error"}). The run stopped; nothing was lost: the message ${f.agent} was handling is still unread and the work done so far is kept.`,
    ...tried,
    "To fix it:",
    `  1. Read why it failed: ${path.join(runDir, "log.jsonl")} (event "wake"), and the full output of each attempt in ${path.join(runDir, "mail", "attempts")}`,
    `  2. Fix the cause: the ${f.agent} CLI (installed, logged in, model name), a timeout (dispatcher.wake_timeout_sec), or its AGENT.md / the message it keeps failing on. Check with: agent-lyceum doctor -p ${project}`,
    "To go on:",
    `  agent-lyceum resume ${run} -p ${project}      (the same message is handled again; the task is not re-sent)`,
    `  Or give up on it: agent-lyceum clear ${run} -p ${project}`,
  ].join("\n");
}

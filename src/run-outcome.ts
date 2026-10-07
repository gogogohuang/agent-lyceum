import type { DoneContract } from "./format.js";
import type { EndReason } from "./run-store.js";
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
export function endOutcome(endReason: EndReason, done?: { outcome: RunOutcome; note?: string }): { outcome: RunOutcome; note?: string } {
  switch (endReason) {
    case "done":
      return { outcome: done?.outcome ?? "partial", note: done?.note };
    case "lead_failed":
      return { outcome: "failed", note: "The lead's wake-up failed." };
    case "cancelled":
      return { outcome: "cancelled", note: "Cancelled before the lead finished. Unread mail was kept; continue with `agent-lyceum resume`." };
    case "idle":
      return { outcome: "partial", note: "All mailboxes were empty but the lead never sent a done message." };
    case "max_rounds":
      return { outcome: "partial", note: "Stopped at the round limit before the lead sent done." };
  }
}

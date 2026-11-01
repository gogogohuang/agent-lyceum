import path from "node:path";
import { RESULT_FILE, type RunSummary } from "./dispatcher.js";
import { failureGuide } from "./run-outcome.js";
import { runLabel } from "./run-store.js";

/** What a finished run prints on the terminal. */
export function printRun(summary: RunSummary, runDir: string): void {
  console.log(`\nRun ${runLabel({ name: summary.name, run_id: summary.runId })} ended: ${summary.endReason}, outcome: ${summary.outcome}, after ${summary.rounds} round(s). Logs: ${path.join(runDir, "log.jsonl")}`);
  if (summary.outcomeNote) console.log(`Note: ${summary.outcomeNote}`);
  if (summary.failure) console.log(failureGuide(summary.project, summary.name ?? summary.runId, summary.failure, runDir));
  if (summary.verification) console.log(summary.dispatcherVerification ? `Verification (the lead's own report): ${summary.verification}` : `Verification (as reported by the lead, not checked by agent-lyceum): ${summary.verification}`);
  if (summary.dispatcherVerification) console.log(`Dispatcher verification (run by agent-lyceum): ${summary.dispatcherVerification.text}`);
  if (summary.resultBranch?.files) {
    console.log(`\nThe work is on branch ${summary.resultBranch.branch} (${summary.resultBranch.files} file(s)); your working tree was not touched.\nBring it in with: git merge ${summary.resultBranch.branch}${summary.resultBranch.patch ? `\n(or apply the patch: git apply ${summary.resultBranch.patch})` : ""}`);
  }
  if (summary.pr) {
    if (summary.pr.status === "opened") console.log(`\nPull request ${summary.pr.updated ? "updated" : "opened"}: ${summary.pr.url}`);
    else if (summary.pr.status === "skipped") console.log(`\nA pull request was asked for but not opened: ${summary.pr.reason}`);
    else console.log(`\nThe pull request could not be opened (${summary.pr.step}: ${summary.pr.reason}).${summary.pr.manual.length ? ` To finish by hand:\n${summary.pr.manual.map((m) => `  ${m}`).join("\n")}` : ""}`);
  }
  if (summary.doneMessage) {
    console.log(`\nLead's final message — ${summary.doneMessage.subject}\n\n${summary.doneMessage.body}`);
    console.log(`\nResult saved to: ${path.join(runDir, RESULT_FILE)}`);
  }
}

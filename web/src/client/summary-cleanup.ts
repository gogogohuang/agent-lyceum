import type { Body, CommandId } from "../commands";
import type { ShortOutcome } from "./api";
import { type SummaryStore, summaries } from "./summary-store";

export type ShortResultHandler = (id: CommandId, body: Body, outcome: ShortOutcome) => void;

/** Forget stored progress only for what a command actually deleted. A dry run, a failure or a timeout leaves it. */
export function createSummaryCleanup(store: Pick<SummaryStore, "forget" | "forgetProject">): ShortResultHandler {
  return (id, body, outcome) => {
    if (outcome.exit !== 0) return;
    if (id === "clear" && body.dryRun !== true && typeof body.project === "string" && typeof body.run === "string") {
      store.forget(body.project, body.run);
    } else if (id === "project.remove" && body.purge === true && typeof body.name === "string") {
      store.forgetProject(body.name);
    }
  };
}

export const forgetDeletedSummaries = createSummaryCleanup(summaries);

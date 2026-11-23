import fs from "node:fs";
import path from "node:path";
import type { Invoker } from "./adapters/index.js";
import type { ResolvedProject } from "./config.js";
import { fingerprint, listMemoryFiles, tidyStamp, tidyWorkDir, wakeWithRollback } from "./memory-tidy.js";
import { memoryDirs, proposalsDir, recordsDir } from "./policy.js";
import { buildReviewPrompts } from "./prompt.js";
import { checkDecisions, listProposals, pendingProposals, proposalStatusOf } from "./proposals.js";
import { recordsOverBudget } from "./records.js";

export interface ReviewOptions {
  project: ResolvedProject;
  invoker?: Invoker;
  signal?: AbortSignal;
  say?: (line: string) => void;
  now?: () => Date;
}

export interface ReviewResult {
  status: "reviewed" | "nothing" | "failed";
  /** The report the lead wrote (only for a finished review). */
  report?: string;
  accepted: number;
  rejected: number;
  problems: string[];
}

/** Where the lead's report of one review goes: inside the proposals folder, which is the only place besides the records it may write. */
export const reviewReportFile = (project: ResolvedProject, stamp: string): string => path.join(proposalsDir(project), ".reviews", `${stamp}.md`);

/**
 * Wake the project's lead once to decide the pending proposals (spec 30, D-14). This function writes nothing itself and
 * decides nothing: the lead does, inside the same all-or-nothing wake a memory tidy uses, and a decision that is incomplete,
 * a record or proposal that disappeared, or a records kind over its budget puts everything back. The caller holds the
 * project's exclusive lock. It never goes through the guard.
 */
export async function reviewProposals(o: ReviewOptions): Promise<ReviewResult> {
  const { project } = o;
  const say = o.say ?? ((s: string) => console.log(s));
  const pending = pendingProposals(project);
  if (pending.length === 0) return { status: "nothing", accepted: 0, rejected: 0, problems: [] };

  const stamp = tidyStamp(o.now?.());
  const lead = project.agents[project.lead];
  if (!lead) return { status: "failed", accepted: 0, rejected: 0, problems: [`the lead "${project.lead}" is not an agent of the project`] };
  const pDir = proposalsDir(project);
  const rDir = recordsDir(project);
  fs.mkdirSync(path.join(pDir, ".reviews"), { recursive: true }); // D-18: runtimes only get directories that exist
  fs.mkdirSync(rDir, { recursive: true });

  const report = reviewReportFile(project, stamp);
  const statusBefore = new Map(pending.map((p) => [p.file, p.status ?? "proposed"]));
  const hashBefore = fingerprint(pDir);
  const decidedBefore = new Set(
    listProposals(project)
      .filter((p) => p.status === "accepted" || p.status === "rejected")
      .map((p) => path.relative(pDir, p.file)),
  );
  const recordsBefore = listMemoryFiles(rDir).map((f) => f.rel);

  say(`reviewing ${pending.length} proposal(s) with ${project.lead} …`);
  const woke = await wakeWithRollback({
    project,
    agentName: project.lead,
    dirs: [rDir, pDir],
    allowDirs: [rDir, pDir],
    others: memoryDirs(lead).filter((d) => fs.existsSync(d)),
    othersLabel: "not the records or the proposals",
    workDir: tidyWorkDir(project, stamp, `review-${project.lead}`),
    prompts: buildReviewPrompts(project, lead, report),
    invoker: o.invoker,
    signal: o.signal,
    check: () => {
      const problems: string[] = [];
      // Layer 1 of D-09, the same function a lead's `done` uses.
      for (const d of checkDecisions(listProposals(project), project)) problems.push(`${d.file}: ${d.problem}`);
      for (const x of recordsOverBudget(project)) problems.push(`records/${x.kind} hold ${x.bytes} bytes of active entries, over the budget`);
      // Nothing may disappear, and a proposal that was already decided stays as it was (only the lead's decision on a pending one is new).
      const hashAfter = fingerprint(pDir);
      for (const rel of Object.keys(hashBefore)) {
        if (!(rel in hashAfter)) problems.push(`proposals/${rel} was deleted`);
        else if (hashAfter[rel] !== hashBefore[rel] && (rel.startsWith(".archive/") || rel.startsWith(".reviews/") || decidedBefore.has(rel))) problems.push(`proposals/${rel} was already decided or archived and may not change`);
      }
      const recordsAfter = new Set(listMemoryFiles(rDir).map((f) => f.rel));
      for (const rel of recordsBefore) if (!recordsAfter.has(rel)) problems.push(`records/${rel} was deleted (mark it superseded instead)`);
      let ok = false;
      try {
        ok = fs.statSync(report).isFile() && fs.readFileSync(report, "utf8").trim() !== "";
      } catch {
        ok = false;
      }
      if (!ok) problems.push(`the report ${path.relative(project.paths.root, report)} is missing or empty`);
      return problems;
    },
  });
  if (!woke.ok) return { status: "failed", accepted: 0, rejected: 0, problems: woke.problems };

  let accepted = 0;
  let rejected = 0;
  for (const [file, before] of statusBefore) {
    if (before !== "proposed") continue;
    const now = proposalStatusOf(fs.readFileSync(file));
    if (now === "accepted") accepted++;
    else if (now === "rejected") rejected++;
  }
  return { status: "reviewed", report, accepted, rejected, problems: [] };
}

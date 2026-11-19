/** Who did the work and who reviewed it, written as git trailers at the end of agent-lyceum's commit messages. */

export const VERDICTS = ["pass", "changes_requested", "fail"] as const;
export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(v: unknown): v is Verdict {
  return typeof v === "string" && (VERDICTS as readonly string[]).includes(v);
}

/** A review a teammate gave in a `reply` that carried `verdict:`. */
export interface ReviewRecord {
  reviewer: string;
  model?: string;
  verdict: Verdict;
  subject: string;
  at: string;
}

export interface WorkerRef {
  agent: string;
  model?: string;
}

/** `name (model)`, or just `name` when the model is not known. Newlines are dropped so a value cannot start another trailer. */
export function agentLabel(w: WorkerRef): string {
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  return w.model ? `${clean(w.agent)} (${clean(w.model)})` : clean(w.agent);
}

/** The latest review per reviewer, in the order they first reviewed. */
export function latestReviews(reviews: readonly ReviewRecord[]): ReviewRecord[] {
  const byReviewer = new Map<string, ReviewRecord>();
  for (const r of reviews) byReviewer.set(r.reviewer, r);
  return [...byReviewer.values()];
}

/** Trailer block (no leading blank line) for one commit. `Reviewed-by` appears only for reviews that really happened. */
export function trailers(i: { implementers?: readonly WorkerRef[]; lead?: WorkerRef; reviews?: readonly ReviewRecord[]; runId?: string }): string {
  const lines: string[] = [];
  for (const w of i.implementers ?? []) lines.push(`Implemented-by: ${agentLabel(w)}`);
  if (i.lead) lines.push(`Led-by: ${agentLabel(i.lead)}`);
  for (const r of latestReviews(i.reviews ?? [])) lines.push(`Reviewed-by: ${agentLabel({ agent: r.reviewer, model: r.model })} [${r.verdict}]`);
  if (i.runId) lines.push(`Run: ${i.runId.replace(/\s+/g, "")}`);
  lines.push("Generated-by: agent-lyceum");
  return lines.join("\n");
}

/** `<subject>\n\n<body?>\n\n<trailers>`. */
export function withTrailers(subject: string, body: string | undefined, t: string): string {
  return [subject, body?.trim(), t].filter(Boolean).join("\n\n");
}

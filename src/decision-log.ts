import fs from "node:fs";
import path from "node:path";
import type { ResolvedProject } from "./config.js";
import { decisionLogDir } from "./policy.js";

export type DecisionLogResult = { status: "saved" | "exists" | "none"; id?: string; file?: string; reason?: string };

/** Body of the `## <name>` section of a done report, up to the next `## ` heading. */
function section(text: string, name: string): string {
  const m = new RegExp(`^##[ \\t]+${name}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^##[ \\t]|(?![\\s\\S]))`, "m").exec(text);
  return (m?.[1] ?? "").trim();
}

/** "None", "無" and the like are not a decision. */
function isEmpty(body: string): boolean {
  return body === "" || /^(none|n\/a|無|没有|沒有)[.。]?$/i.test(body.replace(/^[-*]\s*/, "").trim());
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Where the entry for a run goes: one stable file per run, so saving twice is harmless. */
export function decisionLogId(runId: string): string {
  return `run-${runId.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 28)}`;
}

/**
 * Keep what a run decided before `clear` deletes the run folder: its `## Decisions` (and `## Not done` as consequences) with the
 * task as context. Never overwrites an existing entry. Returns `none` when the run reported no decision.
 * Throws when the entry cannot be written, so the caller can stop before deleting anything.
 */
export function saveRunDecisions(project: ResolvedProject, runId: string): DecisionLogResult {
  const runDir = path.join(project.paths.runs, runId);
  let result: string;
  try {
    result = fs.readFileSync(path.join(runDir, "result.md"), "utf8");
  } catch {
    return { status: "none", reason: "no result.md" };
  }
  const decisions = section(result, "Decisions");
  if (isEmpty(decisions)) return { status: "none", reason: "the report lists no decisions" };
  let summary = "";
  let started = "";
  try {
    const state = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8")) as { task_summary?: string; started_at?: string };
    summary = state.task_summary ?? "";
    started = state.started_at ?? "";
  } catch {
    // The report is enough to keep.
  }
  const heading = /^#\s+(.+)$/m.exec(result)?.[1]?.trim();
  const title = oneLine(heading || summary || runId).slice(0, 200);
  const date = /^\d{4}-\d{2}-\d{2}/.exec(started)?.[0] ?? new Date().toISOString().slice(0, 10);
  const outcome = /^\*\*Outcome:\*\*\s*(\S+)/m.exec(result)?.[1];
  const notDone = section(result, "Not done");
  const id = decisionLogId(runId);
  const file = path.join(decisionLogDir(project), `${id}.md`);
  const text = [
    "---",
    "status: active",
    `date: ${date}`,
    `title: ${JSON.stringify(title)}`,
    `run: ${JSON.stringify(runId)}`,
    ...(outcome ? [`outcome: ${outcome}`] : []),
    "---",
    "## Context",
    summary.trim() || title,
    "",
    "## Decision",
    decisions,
    ...(isEmpty(notDone) ? [] : ["", "## Consequences", notDone]),
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, text, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { status: "exists", id, file };
    throw e;
  }
  return { status: "saved", id, file };
}

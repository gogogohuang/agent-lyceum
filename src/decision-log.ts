import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ResolvedProject } from "./config.js";
import { decisionLogDir, recordsDir, recordsKindDir } from "./policy.js";

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

type DecisionEntry = { id: string; text: string; outcome?: string };

/** The decision-log entry of one run, or why there is none. Reads the run's report and state; writes nothing. */
function buildEntry(project: ResolvedProject, runId: string): { entry: DecisionEntry } | { reason: string } {
  const runDir = path.join(project.paths.runs, runId);
  let result: string;
  try {
    result = fs.readFileSync(path.join(runDir, "result.md"), "utf8");
  } catch {
    return { reason: "no result.md" };
  }
  const decisions = section(result, "Decisions");
  if (isEmpty(decisions)) return { reason: "the report lists no decisions" };
  let summary = "";
  let started = "";
  let stateOutcome: string | undefined;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8")) as { task_summary?: string; started_at?: string; outcome?: string };
    summary = state.task_summary ?? "";
    started = state.started_at ?? "";
    stateOutcome = state.outcome;
  } catch {
    // The report is enough to keep.
  }
  const heading = /^#\s+(.+)$/m.exec(result)?.[1]?.trim();
  const title = oneLine(heading || summary || runId).slice(0, 200);
  const date = /^\d{4}-\d{2}-\d{2}/.exec(started)?.[0] ?? new Date().toISOString().slice(0, 10);
  const outcome = /^\*\*Outcome:\*\*\s*(\S+)/m.exec(result)?.[1] ?? stateOutcome;
  const notDone = section(result, "Not done");
  const id = decisionLogId(runId);
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
  return { entry: { id, text, ...(outcome ? { outcome } : {}) } };
}

/**
 * Keep what a run decided before `clear` deletes the run folder: its `## Decisions` (and `## Not done` as consequences) with the
 * task as context. Never overwrites an existing entry. Returns `none` when the run reported no decision.
 * Throws when the entry cannot be written, so the caller can stop before deleting anything.
 */
export function saveRunDecisions(project: ResolvedProject, runId: string): DecisionLogResult {
  const built = buildEntry(project, runId);
  if ("reason" in built) return { status: "none", reason: built.reason };
  const { id, text } = built.entry;
  const file = path.join(decisionLogDir(project), `${id}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, text, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { status: "exists", id, file };
    throw e;
  }
  return { status: "saved", id, file };
}

const ID_FILE_RE = /^[a-z0-9-]+\.md$/;
const sha = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/** Ids the records already hold for decisions, live or archived by a tidy: a decision a tidy merged away must not come back. */
function knownDecisionIds(project: ResolvedProject): Set<string> {
  const known = new Set<string>();
  const add = (dir: string) => {
    try {
      for (const n of fs.readdirSync(dir)) if (ID_FILE_RE.test(n)) known.add(n.slice(0, -3));
    } catch {
      // A missing folder holds nothing.
    }
  };
  add(recordsKindDir(project, "decisions"));
  const archive = path.join(recordsDir(project), ".archive");
  try {
    for (const stamp of fs.readdirSync(archive)) add(path.join(archive, stamp, "decisions"));
  } catch {
    // No archive yet.
  }
  return known;
}

/**
 * The decisions a tidy should turn into records before it tidies: the `## Decisions` of every completed run, plus what `clear`
 * kept in the decision log, minus what the records already hold. Only completed runs count; a partial or failed run's choices
 * are often provisional. Writes nothing.
 */
export function listPromotable(project: ResolvedProject): DecisionEntry[] {
  const known = knownDecisionIds(project);
  const out = new Map<string, DecisionEntry>();
  let runs: string[] = [];
  try {
    runs = fs.readdirSync(project.paths.runs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    // No runs yet.
  }
  for (const runId of runs) {
    const built = buildEntry(project, runId);
    if ("reason" in built || built.entry.outcome !== "completed" || known.has(built.entry.id)) continue;
    out.set(built.entry.id, built.entry);
  }
  let kept: string[] = [];
  try {
    kept = fs.readdirSync(decisionLogDir(project)).filter((n) => ID_FILE_RE.test(n)).sort();
  } catch {
    // No decision log.
  }
  for (const n of kept) {
    const id = n.slice(0, -3);
    if (known.has(id)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(decisionLogDir(project), n), "utf8");
    } catch {
      continue;
    }
    if (!/^outcome:\s*completed\s*$/m.test(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "")) continue;
    out.set(id, { id, text, outcome: "completed" });
  }
  return [...out.values()];
}

export const promotedManifest = (project: ResolvedProject, stamp: string): string => path.join(project.paths.root, "tidy-promoted", `${stamp}.json`);

/** Write `listPromotable` into `records/decisions/` (never over an existing file) and note them under `stamp` so `tidy --undo` can take them back. */
export function promoteDecisions(project: ResolvedProject, stamp: string): string[] {
  const todo = listPromotable(project);
  const dir = recordsKindDir(project, "decisions");
  const done: { rel: string; sha: string }[] = [];
  for (const e of todo) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, `${e.id}.md`), e.text, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    done.push({ rel: `decisions/${e.id}.md`, sha: sha(e.text) });
  }
  if (done.length) {
    fs.mkdirSync(path.dirname(promotedManifest(project, stamp)), { recursive: true });
    fs.writeFileSync(promotedManifest(project, stamp), JSON.stringify({ files: done }, null, 2));
  }
  return done.map((d) => d.rel.slice("decisions/".length, -3));
}

/** Remove what the tidy `stamp` promoted, except files someone has changed since. */
export function undoPromoted(project: ResolvedProject, stamp: string): { removed: string[]; kept: { rel: string; reason: string }[] } {
  const removed: string[] = [];
  const kept: { rel: string; reason: string }[] = [];
  let files: { rel: string; sha: string }[];
  try {
    files = (JSON.parse(fs.readFileSync(promotedManifest(project, stamp), "utf8")) as { files: { rel: string; sha: string }[] }).files;
  } catch {
    return { removed, kept };
  }
  for (const f of files) {
    const file = path.join(recordsDir(project), f.rel);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      kept.push({ rel: f.rel, reason: "it is gone already (archived or deleted)" });
      continue;
    }
    if (sha(text) !== f.sha) {
      kept.push({ rel: f.rel, reason: "it was changed after the tidy; it was not removed" });
      continue;
    }
    fs.rmSync(file);
    removed.push(f.rel);
  }
  fs.rmSync(promotedManifest(project, stamp), { force: true });
  return { removed, kept };
}

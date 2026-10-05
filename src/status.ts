import fs from "node:fs";
import path from "node:path";
import type { RunState } from "./dispatcher.js";
import type { ResolvedProject } from "./config.js";
import { listUnread } from "./mailbox.js";
import { enforcementFor } from "./policy.js";

export function latestRun(project: ResolvedProject): { dir: string; state: RunState } | undefined {
  const root = project.paths.runs;
  if (!fs.existsSync(root)) return undefined;
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const d of dirs) {
    const f = path.join(root, d, "state.json");
    if (!fs.existsSync(f)) continue;
    try {
      return { dir: path.join(root, d), state: JSON.parse(fs.readFileSync(f, "utf8")) as RunState };
    } catch {
      /* skip unreadable */
    }
  }
  return undefined;
}

export function listRuns(project: ResolvedProject, limit: number): { dir: string; state: RunState }[] {
  const root = project.paths.runs;
  if (!fs.existsSync(root)) return [];
  const out: { dir: string; state: RunState }[] = [];
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const d of dirs) {
    if (out.length >= limit) break;
    try {
      out.push({ dir: path.join(root, d), state: JSON.parse(fs.readFileSync(path.join(root, d, "state.json"), "utf8")) as RunState });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function runStateLabel(s: RunState): string {
  if (s.end_reason) return `ended: ${s.end_reason}`;
  return alive(s.pid) ? "running" : "interrupted";
}

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const tokens = (n: number | undefined) => (n ? n.toLocaleString("en-US") : "0");

function since(iso: string, now: number): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

function handlingText(h: { from: string; type: string; subject: string }[]): string {
  return h.length ? h.map((m) => `${m.type} from ${m.from}: "${clip(m.subject, 60)}"`).join("; ") : "(no messages)";
}

/** What a run is doing / did, one line per wake. */
function describeRun(s: RunState, now: number): string[] {
  const lines = [
    `Run ${s.run_id}  [${runStateLabel(s)}]  rounds ${s.rounds}/${s.max_rounds}  output tokens ${tokens(s.output_tokens)}`,
    `  task: ${s.task_summary ?? (s.task_source === "file" ? `file ${s.task_path}` : "text")}`,
  ];
  for (const w of s.wakes ?? []) {
    lines.push(
      `  #${w.round} ${w.agent} ${w.ok ? "ok" : "FAILED"} (${Math.round(w.duration_ms / 1000)}s, ${tokens(w.output_tokens)} tok) — ${handlingText(w.handling)}`,
    );
  }
  for (const [agent, a] of Object.entries(s.active ?? {})) {
    lines.push(`  #${a.round} ${agent} WORKING for ${since(a.since, now)} — ${handlingText(a.handling)}`);
  }
  return lines;
}

/** Live view: agent table plus the most recent runs, each with what it is doing. */
export function formatMonitor(project: ResolvedProject, runLimit = 3, now = Date.now()): string {
  const runs = listRuns(project, runLimit);
  const out = [formatStatus(project, now), "", "Runs (newest first):"];
  if (runs.length === 0) out.push("  none");
  for (const r of runs) out.push("", ...describeRun(r.state, now));
  return out.join("\n");
}

/** What is running right now in the latest run (or was, if its process died). */
function activeNow(run: { state: RunState } | undefined, now: number): string[] {
  const entries = Object.entries(run?.state.active ?? {});
  if (!run || entries.length === 0) return ["Active now: idle"];
  const live = alive(run.state.pid) && !run.state.end_reason;
  return [
    "Active now:",
    ...entries.map(([agent, a]) =>
      live
        ? `  #${a.round} ${agent} WORKING for ${since(a.since, now)} — ${handlingText(a.handling)}`
        : `  #${a.round} ${agent} interrupted (was working on) — ${handlingText(a.handling)}`,
    ),
  ];
}

export function formatStatus(project: ResolvedProject, now = Date.now()): string {
  const run = latestRun(project);
  const rows = [["agent", "runtime", "unread", "protection", "last wake"]];
  for (const a of Object.values(project.agents)) {
    const e = enforcementFor(project, a);
    const lw = run?.state.last_wake[a.name];
    const levels = [...new Set([e.memory, e.agentMd, e.otherContext, e.repoInstructions])].join("/");
    rows.push([
      a.name + (a.name === project.lead ? " (lead)" : ""),
      a.runtime ?? "?",
      String(listUnread(project, a.name).length),
      levels,
      lw ? `${lw.ok ? "ok" : "FAILED"} ${lw.at}` : "-",
    ]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const table = rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd());
  table.splice(1, 0, w.map((n) => "-".repeat(n)).join("  "));

  const lines = [`Project: ${project.name}  (repo: ${project.dir})`, "", ...table, "", ...activeNow(run, now), ""];
  if (!run) lines.push("No runs yet.");
  else {
    const s = run.state;
    lines.push(
      `Last run: ${s.run_id}`,
      `  task:    ${s.task_source === "file" ? `file ${s.task_path}` : "text"}`,
      `  rounds:  ${s.rounds}/${s.max_rounds}`,
      `  state:   ${runStateLabel(s)}`,
      `  output tokens: ${tokens(s.output_tokens)}`,
    );
  }
  return lines.join("\n");
}

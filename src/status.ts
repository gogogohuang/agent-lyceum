import fs from "node:fs";
import path from "node:path";
import type { RunState, WakeTopic } from "./dispatcher.js";
import type { ResolvedProject } from "./config.js";
import type { Step } from "./format.js";
import { listUnread, type Message } from "./mailbox.js";
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

function handlingText(h: WakeTopic[]): string {
  if (!h.length) return "(no messages)";
  return h
    .map((m) => `${m.type} from ${m.from}: "${clip(m.subject, 60)}"${m.brief ? ` — ${clip(m.brief, 80)}` : ""}`)
    .join("; ");
}

const sentText = (sent: { to: string; type: string; subject: string }[] | undefined): string =>
  sent?.length
    ? sent.map((m) => (m.to === "(done)" ? `finished: "${clip(m.subject, 50)}"` : `${m.to} ← ${m.type} "${clip(m.subject, 50)}"`)).join("; ")
    : "no mail sent";

export function progressBar(done: number, total: number, width = 10): string {
  const n = total ? Math.round((done / total) * width) : 0;
  return "█".repeat(n) + "░".repeat(width - n);
}

function stepsLine(steps: Step[] | undefined): string | undefined {
  if (!steps?.length) return undefined;
  const done = steps.filter((x) => x.done).length;
  const cur = steps.find((x) => !x.done);
  return `${progressBar(done, steps.length)} ${done}/${steps.length} steps${cur ? ` — next step: ${clip(cur.text, 60)}` : " — all done"}`;
}

/** Agents in wake order, newest last; the ones working now are bracketed. */
function flowLine(s: RunState, live: boolean): string {
  const names = (s.wakes ?? []).map((w) => w.agent);
  const shown = names.slice(-7);
  const parts = shown.map((n) => n);
  const activeNames = live ? Object.keys(s.active ?? {}) : [];
  const out = (names.length > shown.length ? "… → " : "") + parts.join(" → ");
  if (!activeNames.length) return out || "(nothing yet)";
  return `${out}${out ? " → " : ""}[${activeNames.join(", ")}]`;
}

/** Order the dispatcher will wake agents: the lead first, otherwise the oldest mail. */
function queuedNext(project: ResolvedProject): { agent: string; msg: Message }[] {
  const rows = Object.values(project.agents)
    .map((a) => ({ agent: a.name, msg: listUnread(project, a.name)[0] }))
    .filter((r): r is { agent: string; msg: Message } => !!r.msg);
  rows.sort((x, y) => {
    if ((x.agent === project.lead) !== (y.agent === project.lead)) return x.agent === project.lead ? -1 : 1;
    return path.basename(x.msg.file).localeCompare(path.basename(y.msg.file));
  });
  return rows;
}

const mailText = (m: Message) => `${m.meta.type} from ${m.meta.from}: "${clip(m.meta.subject, 60)}"`;

/** The readable top block: what is happening, what is next, how far along the task is. */
function summaryBlock(project: ResolvedProject, run: { state: RunState } | undefined, now: number): string[] {
  if (!run) return ["Now:      idle (no runs yet)"];
  const s = run.state;
  const live = alive(s.pid) && !s.end_reason;
  const lines = [`Run ${s.run_id}  [${runStateLabel(s)}]  round ${s.rounds}/${s.max_rounds}`, `Task:     ${s.task_summary ?? (s.task_source === "file" ? `file ${s.task_path}` : "text")}`];

  const steps = stepsLine(s.steps);
  lines.push(`Progress: ${steps ?? `no checklist; ${s.rounds}/${s.max_rounds} rounds used (the lead can add a "## Steps" checklist to its mail)`}`);

  const active = Object.entries(s.active ?? {});
  if (active.length) {
    active.forEach(([agent, a], i) =>
      lines.push(
        `${i === 0 ? "Now:      " : "          "}${agent} ${live ? `working for ${since(a.since, now)}` : "was working (interrupted)"} on ${handlingText(a.handling)}`,
      ),
    );
  } else lines.push(`Now:      idle${s.end_reason ? ` (run ended: ${s.end_reason})` : live ? "" : " (run is not running)"}`);

  const queue = live || !s.end_reason ? queuedNext(project) : [];
  if (queue.length) {
    queue.slice(0, 3).forEach((q, i) => lines.push(`${i === 0 ? "Next:     " : "          "}${q.agent} ← ${mailText(q.msg)}`));
    if (queue.length > 3) lines.push(`          … and ${queue.length - 3} more`);
  } else if (active.length && live) lines.push("Next:     waiting for the working agent(s) to finish, then their mail is routed");
  else lines.push(`Next:     ${s.end_reason === "done" ? "nothing — the lead finished the task" : "nothing queued"}`);

  const lastWake = (s.wakes ?? []).at(-1);
  if (lastWake) lines.push(`Last:     #${lastWake.round} ${lastWake.agent} ${lastWake.ok ? "ok" : "FAILED"} → ${sentText(lastWake.sent)}`);
  lines.push(`Flow:     ${flowLine(s, live)}`);
  return lines;
}

/** What a run is doing / did, one line per wake. */
function describeRun(s: RunState, now: number): string[] {
  const lines = [
    `Run ${s.run_id}  [${runStateLabel(s)}]  rounds ${s.rounds}/${s.max_rounds}  output tokens ${tokens(s.output_tokens)}`,
    `  task: ${s.task_summary ?? (s.task_source === "file" ? `file ${s.task_path}` : "text")}`,
  ];
  const steps = stepsLine(s.steps);
  if (steps) lines.push(`  progress: ${steps}`);
  for (const w of s.wakes ?? []) {
    lines.push(
      `  #${w.round} ${w.agent} ${w.ok ? "ok" : "FAILED"} (${Math.round(w.duration_ms / 1000)}s, ${tokens(w.output_tokens)} tok) — ${handlingText(w.handling)}`,
      `      → ${sentText(w.sent)}`,
    );
  }
  for (const [agent, a] of Object.entries(s.active ?? {})) {
    lines.push(`  #${a.round} ${agent} WORKING for ${since(a.since, now)} — ${handlingText(a.handling)}`);
  }
  return lines;
}

/** Live view: summary and agent table, plus the most recent runs wake by wake. */
export function formatMonitor(project: ResolvedProject, runLimit = 3, now = Date.now()): string {
  const runs = listRuns(project, runLimit);
  const out = [formatStatus(project, now), "", "Runs (newest first):"];
  if (runs.length === 0) out.push("  none");
  for (const r of runs) out.push("", ...describeRun(r.state, now));
  return out.join("\n");
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

  const lines = [`Project: ${project.name}  (repo: ${project.dir})`, "", ...summaryBlock(project, run, now), "", ...table];
  if (run) lines.push("", `Output tokens: ${tokens(run.state.output_tokens)}`);
  return lines.join("\n");
}

import fs from "node:fs";
import path from "node:path";
import { RESULT_FILE } from "./dispatcher.js";
import { bindRunProject, loadRunState, outcomeOf, type ActiveWake, type EndReason, type RunState, type WakeRecord, type WakeTopic } from "./run-store.js";
import type { RunOutcome } from "./schema.js";
import type { ResolvedProject } from "./config.js";
import type { Step } from "./format.js";
import { listUnread } from "./mailbox.js";
import { inspectProjectLock, lockHolderAlive } from "./project-lock.js";

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
    if (!fs.existsSync(path.join(root, d, "state.json"))) continue;
    try {
      return { dir: path.join(root, d), state: loadRunState(path.join(root, d)) };
    } catch {
      /* skip unreadable */
    }
  }
  return undefined;
}

/** Newest run that can still be resumed: not done and not currently running. */
export function latestUnfinishedRun(project: ResolvedProject): { dir: string; state: RunState } | undefined {
  return listRuns(project, Infinity).find((r) => r.state.end_reason !== "done" && (r.state.end_reason || !runIsAlive(r.state, project)));
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
      out.push({ dir: path.join(root, d), state: loadRunState(path.join(root, d)) });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/**
 * Is this run's dispatcher running now? Runs with a project lock (schema 2) are judged by the lock holder;
 * the recorded pid is only the fallback for older runs and runs started without a lock.
 */
export function runIsAlive(s: RunState, project?: ResolvedProject): boolean {
  if (project && s.schema_version >= 2) {
    const l = inspectProjectLock(project.paths.root);
    if (l) return l.run_id === s.run_id && lockHolderAlive(l);
  }
  return alive(s.pid);
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

const OUTCOME_ZH = { completed: "完成", partial: "部分完成", blocked: "受阻", failed: "失敗", waiting: "等待回答", cancelled: "已取消" } as const;

export function runStateLabel(s: Pick<RunState, "outcome" | "end_reason"> & { pid?: number }, live = alive(s.pid)): string {
  if (s.end_reason) {
    const o = outcomeOf(s)!;
    // Runs from before outcomes existed: keep what they recorded, but never present it as a checked success.
    if (!o.verified) return s.end_reason === "done" ? "已結束：完成（未驗證）" : `已結束：${s.end_reason}`;
    return o.outcome === "completed" ? "已結束：完成" : `已結束：${OUTCOME_ZH[o.outcome]}${s.end_reason === "done" ? "" : `（${s.end_reason}）`}`;
  }
  return live ? "執行中" : "已中斷";
}

/** ANSI styling; `paint(false)` returns identity functions so output stays plain for pipes and tests. */
export interface Paint {
  bold: (t: string) => string;
  dim: (t: string) => string;
  red: (t: string) => string;
  green: (t: string) => string;
  yellow: (t: string) => string;
  cyan: (t: string) => string;
}

export function paint(on: boolean): Paint {
  const wrap = (code: string) => (t: string) => (on ? `\x1b[${code}m${t}\x1b[0m` : t);
  return { bold: wrap("1"), dim: wrap("2"), red: wrap("31"), green: wrap("32"), yellow: wrap("33"), cyan: wrap("36") };
}

/** Color a run-state label: running green, interrupted yellow, ended done green / otherwise red. */
function stateColor(c: Paint, label: string): string {
  if (label === "執行中" || label === "已結束：完成") return c.green(label);
  if (label === "已中斷" || label.startsWith("已結束：完成（未驗證") || label.startsWith("已結束：部分完成") || label.startsWith("已結束：受阻")) return c.yellow(label);
  return c.red(label);
}

const okText = (c: Paint, ok: boolean) => (ok ? c.green("成功") : c.red("失敗"));

/** Terminal columns: CJK characters take two. */
const cols = (t: string) => [...t].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);
const padCols = (t: string, n: number) => t + " ".repeat(Math.max(0, n - cols(t)));

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const tokens = (n: number | undefined) => (n ? n.toLocaleString("en-US") : "0");

function since(iso: string, now: number): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

function handlingText(h: WakeTopic[]): string {
  if (!h.length) return "（無訊息）";
  return h
    .map((m) => `來自 ${m.from} 的 ${m.type}：「${clip(m.subject, 60)}」${m.brief ? ` — ${clip(m.brief, 80)}` : ""}`)
    .join("; ");
}

const sentText = (sent: { to: string; type: string; subject: string }[] | undefined): string =>
  sent?.length
    ? sent.map((m) => (m.to === "(done)" ? `完成：「${clip(m.subject, 50)}」` : `${m.to} ← ${m.type}「${clip(m.subject, 50)}」`)).join("; ")
    : "未寄出信件";

export function progressBar(done: number, total: number, width = 10, c: Paint = paint(false)): string {
  const n = total ? Math.round((done / total) * width) : 0;
  return c.green("█".repeat(n)) + c.dim("░".repeat(width - n));
}

function stepsLine(steps: Step[] | undefined, c: Paint, finished = false): string | undefined {
  if (!steps?.length) return undefined;
  const cur = steps.find((x) => !x.done);
  if (!cur) return "全部完成";
  if (finished) return c.yellow(`⚠ lead 宣告完成，但步驟「${clip(cur.text, 60)}」尚未勾選`);
  return `目前：${clip(cur.text, 60)}`;
}

// ---- the report: everything `status` shows, computed once; the text pages and --json are both made from it ----

export interface QueueItem {
  agent: string;
  from: string;
  type: string;
  subject: string;
}

export interface RunReport {
  run_id: string;
  dir: string;
  /** running: its dispatcher is alive; interrupted: it died mid-run; ended: it stopped (see end_reason). */
  state: "running" | "interrupted" | "ended";
  live: boolean;
  end_reason?: EndReason;
  outcome?: RunOutcome;
  /** False for runs that ended before outcomes were recorded: `outcome` is then only a cautious reading. */
  outcome_verified: boolean;
  outcome_note?: string;
  verification?: string;
  started_at: string;
  ended_at?: string;
  rounds: number;
  max_rounds: number;
  output_tokens: number;
  task_source: "text" | "file";
  task_path?: string;
  task_summary: string;
  steps?: Step[];
  current_step: string | null;
  active: Record<string, ActiveWake>;
  /** Who is woken next, in order (empty once the run ended). */
  queue: QueueItem[];
  wakes: WakeRecord[];
  notes: string[];
  blocked_integrations: { agent: string; branch: string; reason: string; report: string }[];
  result_path?: string;
  /** First lines of the result, for the summary page. */
  result_head: string[];
  mail_layout: "run" | "legacy";
  workspace_mode?: "shared" | "worktree";
  last_wake: Record<string, { at: string; ok: boolean; error?: string }>;
}

export interface AgentReport {
  name: string;
  runtime?: string;
  lead: boolean;
  unread: number;
  last_wake?: { at: string; ok: boolean; error?: string };
}

export interface StatusReport {
  schema_version: 1;
  project: { name: string; dir: string; lead: string };
  agents: AgentReport[];
  run?: RunReport;
}

export interface TaskListReport {
  schema_version: 1;
  project: { name: string; dir: string; lead: string };
  runs: RunReport[];
}

/** Order the dispatcher will wake agents: the lead first, otherwise the oldest mail. */
function queueOf(project: ResolvedProject): QueueItem[] {
  const rows = Object.values(project.agents)
    .map((a) => ({ agent: a.name, msg: listUnread(project, a.name)[0] }))
    .flatMap((r) => (r.msg ? [{ agent: r.agent, msg: r.msg }] : []));
  rows.sort((x, y) => {
    if ((x.agent === project.lead) !== (y.agent === project.lead)) return x.agent === project.lead ? -1 : 1;
    return path.basename(x.msg.file).localeCompare(path.basename(y.msg.file));
  });
  return rows.map((r) => ({ agent: r.agent, from: r.msg.meta.from, type: r.msg.meta.type, subject: r.msg.meta.subject }));
}

/** One run as `status` sees it. Without `project`, liveness falls back to the recorded pid and there is no queue. */
export function buildRunReport(run: { dir: string; state: RunState }, project?: ResolvedProject, opts: { detail?: boolean } = {}): RunReport {
  const s = run.state;
  const detail = opts.detail ?? true;
  const live = runIsAlive(s, project) && !s.end_reason;
  const o = outcomeOf(s);
  const bound = project ? bindRunProject(project, run.dir, s.mail_layout) : undefined;
  const result = path.join(run.dir, RESULT_FILE);
  const hasResult = detail && s.end_reason === "done" && fs.existsSync(result);
  const cur = s.steps?.find((x) => !x.done);
  return {
    run_id: s.run_id,
    dir: run.dir,
    state: s.end_reason ? "ended" : live ? "running" : "interrupted",
    live,
    end_reason: s.end_reason,
    outcome: o?.outcome,
    outcome_verified: o?.verified ?? false,
    outcome_note: s.outcome_note,
    verification: s.verification,
    started_at: s.started_at,
    ended_at: s.ended_at,
    rounds: s.rounds,
    max_rounds: s.max_rounds,
    output_tokens: s.output_tokens,
    task_source: s.task_source,
    task_path: s.task_path,
    task_summary: s.task_summary,
    steps: s.steps,
    current_step: cur?.text ?? null,
    active: s.active,
    // mail still waiting is what `resume` will pick up, so it is shown for every run that did not finish with a done
    queue: detail && bound && s.end_reason !== "done" ? queueOf(bound) : [],
    wakes: s.wakes,
    notes: s.notes ?? [],
    blocked_integrations: s.blocked_integrations ?? [],
    result_path: fs.existsSync(result) ? result : undefined,
    result_head: hasResult ? fs.readFileSync(result, "utf8").split("\n").filter((l) => l.trim()).slice(0, 4) : [],
    mail_layout: s.mail_layout,
    workspace_mode: s.workspace_mode,
    last_wake: s.last_wake,
  };
}

const projectInfo = (p: ResolvedProject) => ({ name: p.name, dir: p.dir, lead: p.lead });

/** The status of a project: its agents and one run (the newest, or the one named by `runId`). */
export function buildStatusReport(base: ResolvedProject, runId?: string): StatusReport {
  let run: { dir: string; state: RunState } | undefined;
  if (runId) {
    const dir = path.join(base.paths.runs, runId);
    if (!fs.existsSync(path.join(dir, "state.json"))) throw new Error(`Run "${runId}" not found in ${base.paths.runs}. List ids with: agent-lyceum status --task-list`);
    run = { dir, state: loadRunState(dir) };
  } else run = latestRun(base);
  // Mail is per run: count the unread mail of the run being shown.
  const project = run ? bindRunProject(base, run.dir, run.state.mail_layout) : base;
  const report = run ? buildRunReport(run, base) : undefined;
  return {
    schema_version: 1,
    project: projectInfo(base),
    agents: Object.values(project.agents).map((a) => ({
      name: a.name,
      runtime: a.runtime,
      lead: a.name === project.lead,
      unread: listUnread(project, a.name).length,
      last_wake: run?.state.last_wake[a.name],
    })),
    run: report,
  };
}

/** Every run of the project, newest first. */
export function buildTaskListReport(project: ResolvedProject): TaskListReport {
  return { schema_version: 1, project: projectInfo(project), runs: listRuns(project, Infinity).map((r) => buildRunReport(r, project, { detail: false })) };
}

// ---- text pages ----

/** Agents in wake order, newest last; the ones working now are bracketed. */
function flowLine(r: RunReport, c: Paint): string {
  const names = (r.wakes ?? []).map((w) => w.agent);
  const shown = names.slice(-7);
  const parts = shown.map((n) => c.cyan(n));
  const activeNames = r.live ? Object.keys(r.active ?? {}) : [];
  const out = (names.length > shown.length ? "… → " : "") + parts.join(" → ");
  if (!activeNames.length) return out || "（尚無）";
  return `${out}${out ? " → " : ""}${c.green(`[${activeNames.join(", ")}]`)}`;
}

/** The state label of a report: an outcome that was only inferred (old runs) is not shown as a checked result. */
const reportLabel = (r: RunReport) => runStateLabel({ end_reason: r.end_reason, outcome: r.outcome_verified ? r.outcome : undefined }, r.live);
const mailText = (m: QueueItem) => `來自 ${m.from} 的 ${m.type}：「${clip(m.subject, 60)}」`;
const taskText = (s: RunReport) => s.task_summary ?? (s.task_source === "file" ? `檔案 ${s.task_path}` : "文字");

/** The readable top block: what is happening, what is next, how far along the task is. */
function summaryBlock(run: RunReport | undefined, now: number, c: Paint): string[] {
  const L = (label: string) => c.bold(c.cyan(label)) + " ".repeat(Math.max(1, 10 - cols(label)));
  if (!run) return [`${L("現在：")}${c.dim("閒置（尚無執行紀錄）")}`];
  const s = run;
  const live = s.live;
  const lines = [
    `${c.bold("執行 " + s.run_id)}  [${stateColor(c, reportLabel(s))}]  第 ${s.rounds}/${s.max_rounds} 輪`,
    `${L("任務：")}${taskText(s)}`,
  ];

  const steps = stepsLine(s.steps, c, s.end_reason === "done");
  lines.push(`${L("進度：")}${steps ?? `無清單；已用 ${s.rounds}/${s.max_rounds} 輪（lead 可在信中加入 "## Steps" 清單）`}`);

  const active = Object.entries(s.active ?? {});
  if (active.length) {
    for (const [i, [agent, a]] of active.entries()) {
      lines.push(
        `${i === 0 ? L("現在：") : "          "}${c.cyan(agent)} ${live ? c.green(`工作中 ${since(a.since, now)}`) : c.yellow("曾在工作（已中斷）")}，處理 ${handlingText(a.handling)}`,
      );
    }
  } else lines.push(`${L("現在：")}${c.dim(`閒置${s.end_reason ? `（執行已結束：${s.end_reason}）` : live ? "" : "（執行未在運作）"}`)}`);

  const queue = s.queue;
  if (queue.length) {
    for (const [i, q] of queue.slice(0, 3).entries()) lines.push(`${i === 0 ? L("下一個：") : "          "}${c.cyan(q.agent)} ← ${mailText(q)}`);
    if (queue.length > 3) lines.push(c.dim(`          … 還有 ${queue.length - 3} 筆`));
  } else if (active.length && live) lines.push(`${L("下一個：")}${c.dim("等工作中的 agent 完成後，再轉送其信件")}`);
  else lines.push(`${L("下一個：")}${c.dim(s.end_reason === "done" ? "無 — lead 已完成任務" : "無待處理")}`);

  if (s.end_reason === "done" && s.result_path && s.result_head.length) {
    lines.push(`${L("結果：")}${s.result_path}`, ...s.result_head.map((l) => c.dim("          " + clip(l, 80))));
  }
  const lastWake = (s.wakes ?? []).at(-1);
  if (lastWake) lines.push(`${L("上一次：")}#${lastWake.round} ${c.cyan(lastWake.agent)} ${okText(c, lastWake.ok)} → ${sentText(lastWake.sent)}`);
  lines.push(`${L("流程：")}${flowLine(s, c)}`);
  return lines;
}

/** What a run is doing / did, one line per wake. */
function describeRun(s: RunReport, now: number, c: Paint, limit = Infinity): string[] {
  const lines = [
    `${c.bold("執行 " + s.run_id)}  [${stateColor(c, reportLabel(s))}]  輪次 ${s.rounds}/${s.max_rounds}  輸出 tokens ${tokens(s.output_tokens)}`,
    `  任務：${taskText(s)}`,
  ];
  const steps = stepsLine(s.steps, c);
  if (steps) lines.push(`  進度：${steps}`);
  if (s.outcome_note) lines.push(`  結果說明：${clip(s.outcome_note, 200)}`);
  if (s.verification) lines.push(`  驗證：${clip(s.verification, 200)}`);
  for (const n of s.notes ?? []) lines.push(`  ${c.yellow("⚠ " + clip(n, 200))}`);
  const wakes = s.wakes ?? [];
  if (wakes.length > limit) lines.push(c.dim(`  … 省略較早的 ${wakes.length - limit} 筆（不帶 --monitor 可看完整紀錄）`));
  for (const w of limit < wakes.length ? wakes.slice(-limit) : wakes) {
    lines.push(
      `  #${w.round} ${c.cyan(w.agent)} ${okText(c, w.ok)} (${Math.round(w.duration_ms / 1000)}s, ${tokens(w.output_tokens)} tok) — ${handlingText(w.handling)}`,
      `      → ${sentText(w.sent)}`,
    );
  }
  for (const [agent, a] of Object.entries(s.active ?? {})) {
    lines.push(`  #${a.round} ${c.cyan(agent)} ${c.green(`工作中 ${since(a.since, now)}`)} — ${handlingText(a.handling)}`);
  }
  return lines;
}

const MONITOR_WAKES = 3;

/** Live view: summary and agent table, plus the latest run and any run still going, wake by wake. */
export function formatMonitor(project: ResolvedProject, now = Date.now(), color = false): string {
  const c = paint(color);
  const runs = listRuns(project, 50).filter((r, i) => i === 0 || (!r.state.end_reason && runIsAlive(r.state, project)));
  const out = [formatStatus(project, now, color), "", c.bold("執行紀錄（最新／執行中）：")];
  if (runs.length === 0) out.push("  無");
  for (const r of runs) out.push("", ...describeRun(buildRunReport(r, project, { detail: false }), now, c, MONITOR_WAKES));
  return out.join("\n");
}

/** Plain `status`: the status page followed by the full wake-by-wake record of the latest run. */
export function formatStatusWithLog(project: ResolvedProject, now = Date.now(), color = false): string {
  const c = paint(color);
  const report = buildStatusReport(project);
  const out = [formatStatusReport(report, now, color)];
  if (report.run) out.push("", c.bold("執行紀錄："), ...describeRun(report.run, now, c, Infinity));
  return out.join("\n");
}

/** One run in full: header, every wake, the final result, and where its logs live. */
export function formatRunDetail(run: { dir: string; state: RunState }, now = Date.now(), color = false, project?: ResolvedProject): string {
  return formatRunReport(buildRunReport(run, project, { detail: false }), now, color);
}

export function formatRunReport(r: RunReport, now = Date.now(), color = false): string {
  const c = paint(color);
  const out = [...describeRun(r, now, c, Infinity)];
  if (r.result_path) out.push("", c.bold("結果（" + r.result_path + "）："), fs.readFileSync(r.result_path, "utf8").trimEnd());
  out.push("", c.dim(`目錄：${r.dir}`));
  return out.join("\n");
}

/** Every run of the project, newest first: id, state, rounds, progress and task. */
export function formatTaskList(project: ResolvedProject, color = false): string {
  return formatTaskListReport(buildTaskListReport(project), color);
}

export function formatTaskListReport(report: TaskListReport, color = false): string {
  const c = paint(color);
  const runs = report.runs;
  const head = `${c.bold("專案：")}${report.project.name}  ${c.dim(`（共 ${runs.length} 個任務）`)}`;
  if (!runs.length) return `${head}\n\n無執行紀錄。`;
  const header = ["ID", "狀態", "輪次", "目前步驟", "任務"];
  const rows = [header];
  for (const s of runs) {
    rows.push([
      s.run_id,
      reportLabel(s),
      `${s.rounds}/${s.max_rounds}`,
      s.steps?.length ? (s.current_step ? clip(s.current_step, 30) : "全部完成") : "-",
      clip(taskText(s), 60),
    ]);
  }
  const w = header.map((_, i) => Math.max(...rows.map((r) => cols(r[i] ?? ""))));
  const line = (r: string[], ri: number) =>
    r
      .map((t, i) => {
        const p = i === r.length - 1 ? t : padCols(t, w[i] ?? 0);
        return ri === 0 ? c.bold(p) : i === 1 ? stateColor(c, t) + " ".repeat(Math.max(0, (w[i] ?? 0) - cols(t))) : p;
      })
      .join("  ")
      .trimEnd();
  const table = rows.map(line);
  table.splice(1, 0, c.dim(w.map((n) => "-".repeat(n)).join("  ")));
  return [head, "", ...table, "", c.dim("接續中斷的任務：agent-lyceum resume <ID> -p " + report.project.name)].join("\n");
}

export function formatStatus(base: ResolvedProject, now = Date.now(), color = false): string {
  return formatStatusReport(buildStatusReport(base), now, color);
}

export function formatStatusReport(report: StatusReport, now = Date.now(), color = false): string {
  const c = paint(color);
  const run = report.run;
  const header = ["成員", "執行環境", "未讀", "上次喚醒"];
  const rows = [header];
  for (const a of report.agents) {
    const lw = a.last_wake;
    rows.push([a.name + (a.lead ? " (lead)" : ""), a.runtime ?? "?", String(a.unread), lw ? `${lw.ok ? "成功" : "失敗"} ${lw.at}` : "-"]);
  }
  const w = header.map((_, i) => Math.max(...rows.map((r) => cols(r[i] ?? ""))));
  // Pad on the plain text first so ANSI codes never skew the column widths.
  const cell = (r: string[], ri: number, i: number): string => {
    const text = r[i] ?? "";
    const t = i === r.length - 1 ? text : padCols(text, w[i] ?? 0); // no trailing padding, as in plain output
    if (ri === 0) return c.bold(t);
    if (i === 0) return text.endsWith("(lead)") ? c.cyan(t) : t;
    if (i === 2) return text === "0" ? c.dim(t) : c.yellow(t);
    if (i === 3) return text.startsWith("失敗") ? c.red(t) : text.startsWith("成功") ? c.green(t) : c.dim(t);
    return t;
  };
  const table = rows.map((r, ri) => r.map((_, i) => cell(r, ri, i)).join("  ").trimEnd());
  table.splice(1, 0, c.dim(w.map((n) => "-".repeat(n)).join("  ")));

  const lines = [`${c.bold("專案：")}${report.project.name}  ${c.dim(`（repo：${report.project.dir}）`)}`, "", ...summaryBlock(run, now, c), "", ...table];
  if (run) lines.push("", `輸出 tokens：${tokens(run.output_tokens)}`);
  return lines.join("\n");
}

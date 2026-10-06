import fs from "node:fs";
import path from "node:path";
import { RESULT_FILE } from "./dispatcher.js";
import { loadRunState, type RunState, type WakeTopic } from "./run-store.js";
import type { ResolvedProject } from "./config.js";
import type { Step } from "./format.js";
import { listUnread, type Message } from "./mailbox.js";

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
  return listRuns(project, Infinity).find((r) => r.state.end_reason !== "done" && (r.state.end_reason || !alive(r.state.pid)));
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

export function runIsAlive(s: { pid?: number }): boolean {
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

export function runStateLabel(s: RunState): string {
  if (s.end_reason) return `已結束：${s.end_reason === "done" ? "完成" : s.end_reason}`;
  return alive(s.pid) ? "執行中" : "已中斷";
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
  return label === "已中斷" ? c.yellow(label) : c.red(label);
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

/** Agents in wake order, newest last; the ones working now are bracketed. */
function flowLine(s: RunState, live: boolean, c: Paint): string {
  const names = (s.wakes ?? []).map((w) => w.agent);
  const shown = names.slice(-7);
  const parts = shown.map((n) => c.cyan(n));
  const activeNames = live ? Object.keys(s.active ?? {}) : [];
  const out = (names.length > shown.length ? "… → " : "") + parts.join(" → ");
  if (!activeNames.length) return out || "（尚無）";
  return `${out}${out ? " → " : ""}${c.green(`[${activeNames.join(", ")}]`)}`;
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

const mailText = (m: Message) => `來自 ${m.meta.from} 的 ${m.meta.type}：「${clip(m.meta.subject, 60)}」`;

/** The readable top block: what is happening, what is next, how far along the task is. */
function summaryBlock(project: ResolvedProject, run: { dir?: string; state: RunState } | undefined, now: number, c: Paint): string[] {
  const L = (label: string) => c.bold(c.cyan(label)) + " ".repeat(Math.max(1, 10 - cols(label)));
  if (!run) return [`${L("現在：")}${c.dim("閒置（尚無執行紀錄）")}`];
  const s = run.state;
  const live = alive(s.pid) && !s.end_reason;
  const lines = [
    `${c.bold("執行 " + s.run_id)}  [${stateColor(c, runStateLabel(s))}]  第 ${s.rounds}/${s.max_rounds} 輪`,
    `${L("任務：")}${s.task_summary ?? (s.task_source === "file" ? `檔案 ${s.task_path}` : "文字")}`,
  ];

  const steps = stepsLine(s.steps, c, s.end_reason === "done");
  lines.push(`${L("進度：")}${steps ?? `無清單；已用 ${s.rounds}/${s.max_rounds} 輪（lead 可在信中加入 "## Steps" 清單）`}`);

  const active = Object.entries(s.active ?? {});
  if (active.length) {
    active.forEach(([agent, a], i) =>
      lines.push(
        `${i === 0 ? L("現在：") : "          "}${c.cyan(agent)} ${live ? c.green(`工作中 ${since(a.since, now)}`) : c.yellow("曾在工作（已中斷）")}，處理 ${handlingText(a.handling)}`,
      ),
    );
  } else lines.push(`${L("現在：")}${c.dim(`閒置${s.end_reason ? `（執行已結束：${s.end_reason}）` : live ? "" : "（執行未在運作）"}`)}`);

  const queue = live || !s.end_reason ? queuedNext(project) : [];
  if (queue.length) {
    queue.slice(0, 3).forEach((q, i) => lines.push(`${i === 0 ? L("下一個：") : "          "}${c.cyan(q.agent)} ← ${mailText(q.msg)}`));
    if (queue.length > 3) lines.push(c.dim(`          … 還有 ${queue.length - 3} 筆`));
  } else if (active.length && live) lines.push(`${L("下一個：")}${c.dim("等工作中的 agent 完成後，再轉送其信件")}`);
  else lines.push(`${L("下一個：")}${c.dim(s.end_reason === "done" ? "無 — lead 已完成任務" : "無待處理")}`);

  const result = run.dir ? path.join(run.dir, RESULT_FILE) : "";
  if (s.end_reason === "done" && result && fs.existsSync(result)) {
    const head = fs.readFileSync(result, "utf8").split("\n").filter((l) => l.trim()).slice(0, 4).map((l) => clip(l, 80));
    lines.push(`${L("結果：")}${result}`, ...head.map((l) => c.dim("          " + l)));
  }
  const lastWake = (s.wakes ?? []).at(-1);
  if (lastWake) lines.push(`${L("上一次：")}#${lastWake.round} ${c.cyan(lastWake.agent)} ${okText(c, lastWake.ok)} → ${sentText(lastWake.sent)}`);
  lines.push(`${L("流程：")}${flowLine(s, live, c)}`);
  return lines;
}

/** What a run is doing / did, one line per wake. */
function describeRun(s: RunState, now: number, c: Paint, limit = Infinity): string[] {
  const lines = [
    `${c.bold("執行 " + s.run_id)}  [${stateColor(c, runStateLabel(s))}]  輪次 ${s.rounds}/${s.max_rounds}  輸出 tokens ${tokens(s.output_tokens)}`,
    `  任務：${s.task_summary ?? (s.task_source === "file" ? `檔案 ${s.task_path}` : "文字")}`,
  ];
  const steps = stepsLine(s.steps, c);
  if (steps) lines.push(`  進度：${steps}`);
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
  const runs = listRuns(project, 50).filter((r, i) => i === 0 || (!r.state.end_reason && runIsAlive(r.state)));
  const out = [formatStatus(project, now, color), "", c.bold("執行紀錄（最新／執行中）：")];
  if (runs.length === 0) out.push("  無");
  for (const r of runs) out.push("", ...describeRun(r.state, now, c, MONITOR_WAKES));
  return out.join("\n");
}

/** Plain `status`: the status page followed by the full wake-by-wake record of the latest run. */
export function formatStatusWithLog(project: ResolvedProject, now = Date.now(), color = false): string {
  const c = paint(color);
  const run = latestRun(project);
  const out = [formatStatus(project, now, color)];
  if (run) out.push("", c.bold("執行紀錄："), ...describeRun(run.state, now, c));
  return out.join("\n");
}

/** One run in full: header, every wake, the final result, and where its logs live. */
export function formatRunDetail(run: { dir: string; state: RunState }, now = Date.now(), color = false): string {
  const c = paint(color);
  const out = [...describeRun(run.state, now, c)];
  const result = path.join(run.dir, RESULT_FILE);
  if (fs.existsSync(result)) out.push("", c.bold("結果（" + result + "）："), fs.readFileSync(result, "utf8").trimEnd());
  out.push("", c.dim(`目錄：${run.dir}`));
  return out.join("\n");
}

/** Every run of the project, newest first: id, state, rounds, progress and task. */
export function formatTaskList(project: ResolvedProject, color = false): string {
  const c = paint(color);
  const runs = listRuns(project, Infinity);
  const head = `${c.bold("專案：")}${project.name}  ${c.dim(`（共 ${runs.length} 個任務）`)}`;
  if (!runs.length) return `${head}\n\n無執行紀錄。`;
  const rows = [["ID", "狀態", "輪次", "目前步驟", "任務"]];
  for (const { state: s } of runs) {
    const cur = s.steps?.find((x) => !x.done);
    rows.push([
      s.run_id,
      runStateLabel(s),
      `${s.rounds}/${s.max_rounds}`,
      s.steps?.length ? (cur ? clip(cur.text, 30) : "全部完成") : "-",
      clip(s.task_summary ?? (s.task_source === "file" ? `檔案 ${s.task_path}` : "文字"), 60),
    ]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => cols(r[i]))));
  const line = (r: string[], ri: number) =>
    r
      .map((t, i) => {
        const p = i === r.length - 1 ? t : padCols(t, w[i]);
        return ri === 0 ? c.bold(p) : i === 1 ? stateColor(c, t) + " ".repeat(Math.max(0, w[i] - cols(t))) : p;
      })
      .join("  ")
      .trimEnd();
  const table = rows.map(line);
  table.splice(1, 0, c.dim(w.map((n) => "-".repeat(n)).join("  ")));
  return [head, "", ...table, "", c.dim("接續中斷的任務：agent-team resume <ID> -p " + project.name)].join("\n");
}

export function formatStatus(project: ResolvedProject, now = Date.now(), color = false): string {
  const c = paint(color);
  const run = latestRun(project);
  const rows = [["成員", "執行環境", "未讀", "上次喚醒"]];
  for (const a of Object.values(project.agents)) {
    const lw = run?.state.last_wake[a.name];
    rows.push([
      a.name + (a.name === project.lead ? " (lead)" : ""),
      a.runtime ?? "?",
      String(listUnread(project, a.name).length),
      lw ? `${lw.ok ? "成功" : "失敗"} ${lw.at}` : "-",
    ]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => cols(r[i]))));
  // Pad on the plain text first so ANSI codes never skew the column widths.
  const cell = (r: string[], ri: number, i: number): string => {
    const t = i === r.length - 1 ? r[i] : padCols(r[i], w[i]); // no trailing padding, as in plain output
    if (ri === 0) return c.bold(t);
    if (i === 0) return r[0].endsWith("(lead)") ? c.cyan(t) : t;
    if (i === 2) return r[2] === "0" ? c.dim(t) : c.yellow(t);
    if (i === 3) return r[3].startsWith("失敗") ? c.red(t) : r[3].startsWith("成功") ? c.green(t) : c.dim(t);
    return t;
  };
  const table = rows.map((r, ri) => r.map((_, i) => cell(r, ri, i)).join("  ").trimEnd());
  table.splice(1, 0, c.dim(w.map((n) => "-".repeat(n)).join("  ")));

  const lines = [`${c.bold("專案：")}${project.name}  ${c.dim(`（repo：${project.dir}）`)}`, "", ...summaryBlock(project, run, now, c), "", ...table];
  if (run) lines.push("", `輸出 tokens：${tokens(run.state.output_tokens)}`);
  return lines.join("\n");
}
